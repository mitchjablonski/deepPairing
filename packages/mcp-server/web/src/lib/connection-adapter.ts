/**
 * Connection adapter interface.
 * Abstracts the transport layer so the same React app works in both
 * browser (WebSocket) and VS Code webview (message passing).
 */

export interface ConnectionAdapter {
  connect(): void;
  disconnect(): void;
  onMessage(handler: (data: any) => void): void;
  onConnect(handler: () => void): void;
  onDisconnect(handler: () => void): void;
  /**
   * HH1 — optional. When the connection store learns a new
   * projectHash (or any other URL-shaping field), it can call this
   * to have the adapter rebuild its connect URL and reconnect.
   * Adapters that don't carry per-URL state (VS Code message passing)
   * leave this undefined.
   */
  refreshUrl?(): void;
  /**
   * II3 — optional. Fired when the adapter detects (via the
   * /api/daemon-info probe) that the daemon on this port now serves a
   * DIFFERENT project than the one this tab is bound to. This is the
   * cross-bind footgun: a browser tab pinned to project A's hash whose
   * daemon idle-shut and was replaced by project B's daemon on the same
   * port. The WS upgrade only gives the browser close code 1006 (no
   * readable reason), so the classification comes from the probe, not
   * the close event. The adapter stops its reconnect loop and fires this
   * so the connection store can surface a sticky "reload to re-bind"
   * toast — mirroring the BB10 REST-side guard. Pre-II3 the adapter
   * SILENTLY rebound the tab to the live daemon's hash, so comments and
   * approvals could land in the wrong project.
   */
  onFatalMismatch?(
    handler: (info: { liveProjectRoot?: string; liveHash: string }) => void,
  ): void;
}

/**
 * Browser WebSocket adapter — connects directly to the deepPairing server.
 */
export class WebSocketAdapter implements ConnectionAdapter {
  private ws: WebSocket | null = null;
  private url: string;
  private messageHandler: ((data: any) => void) | null = null;
  private connectHandler: (() => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  private fatalMismatchHandler:
    | ((info: { liveProjectRoot?: string; liveHash: string }) => void)
    | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly maxReconnectDelay = 30000;
  /**
   * II3 — set once the probe confirms the live daemon serves a different
   * project. Latches the reconnect loop OFF: `onclose` will not re-arm
   * the timer, so we stop hammering a daemon that will only ever 403 our
   * stale hash. Cleared only by a full reload (the user's "reload to
   * re-bind" action), never silently.
   */
  private fatalMismatch = false;

  // HH1 — track the base separately so we can rebuild this.url whenever
  // the connection store learns projectHash. Pre-HH1 the URL was
  // computed once in the constructor BEFORE the inbound `connected`
  // payload populated projectHash, so every long-lived UI session
  // silently ran on the daemon's back-compat path. The GG2 defense-
  // in-depth was effectively never engaged in real browser sessions.
  private readonly baseUrl: string;

  constructor(url?: string, private sessionId?: string) {
    this.baseUrl = url ?? `ws://${window.location.host}/ws`;
    this.url = WebSocketAdapter.appendQuery(this.baseUrl, sessionId);
  }

  /** Reconnect to a different session */
  switchSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.url = WebSocketAdapter.appendQuery(this.baseUrl, sessionId);
    this.disconnect();
    this.connect();
  }

  /**
   * HH1 — public hook for the connection store to call after the
   * `connected` payload populates projectHash. Rebuilds the URL with
   * the fresh hash and reconnects (so the next WS upgrade carries it).
   * Idempotent: when the URL hasn't changed (already had the hash) it
   * skips the reconnect to avoid flapping. Cheap when called on every
   * `connected` event; the disconnect/connect cycle only fires when
   * the URL actually changed.
   */
  refreshUrl(): void {
    const next = WebSocketAdapter.appendQuery(this.baseUrl, this.sessionId);
    if (next === this.url) return;
    this.url = next;
    this.disconnect();
    this.connect();
  }

  // GG2 — also stamp projectHash on the WS connect URL when the
  // connection store knows it. The daemon's upgrade handler enforces
  // the match (defense-in-depth on top of GG1's 127.0.0.1 bind).
  // Pre-GG2 the URL was just `?sessionId=...` and the daemon accepted
  // any guess; with this every WS upgrade carries the stale-tab
  // guard the AA4 X-Project-Hash middleware already enforces on HTTP.
  private static appendQuery(base: string, sessionId?: string): string {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    try {
      const projectHash = (window as any).__dpConnectionStore?.getState?.()?.projectHash;
      if (typeof projectHash === "string" && projectHash) {
        params.set("projectHash", projectHash);
      }
    } catch {
      // Connection store not yet available (early mount); the daemon
      // back-compat path accepts the upgrade without a hash.
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  connect(): void {
    if (this.ws && this.ws.readyState <= 1) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0; // Reset backoff on successful connect
      this.connectHandler?.();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.messageHandler?.(data);
      } catch { /* ignore malformed */ }
    };

    this.ws.onclose = () => {
      this.disconnectHandler?.();
      // II3 — a confirmed cross-project mismatch latches the loop OFF.
      // Don't re-arm: the daemon on this port serves a different project
      // and will only ever 403 our stale hash. The user must reload to
      // re-bind (the toast the store pushes on onFatalMismatch).
      if (this.fatalMismatch) return;
      // Auto-reconnect with exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s...
      this.reconnectAttempt++;
      const delay = Math.min(
        1000 * Math.pow(2, this.reconnectAttempt - 1),
        this.maxReconnectDelay,
      );
      // HH4 — stale-tab probe. After 3 consecutive failed connects, the
      // daemon is likely either down OR has restarted on the same port
      // serving a different project (so the GG2 gate keeps 403'ing our
      // cached projectHash). A failed WS upgrade only gives us close code
      // 1006 (no readable reason), so we classify via /api/daemon-info:
      //   - probe fails entirely  → genuine outage; keep reconnecting.
      //   - probe ok, hash matches → same project; keep reconnecting.
      //   - probe ok, hash differs → cross-bind; II3 fires onFatalMismatch
      //     and clears the timer below instead of silently rebinding.
      if (this.reconnectAttempt >= 3) {
        void this.probeDaemonAndMaybeRefresh();
      }
      // probeDaemonAndMaybeRefresh may have set fatalMismatch synchronously
      // before this line on a fast (mocked/test) fetch; guard again so we
      // never arm a timer the probe just decided to kill.
      if (this.fatalMismatch) {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        return;
      }
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  onMessage(handler: (data: any) => void): void {
    this.messageHandler = handler;
  }

  onConnect(handler: () => void): void {
    this.connectHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  onFatalMismatch(
    handler: (info: { liveProjectRoot?: string; liveHash: string }) => void,
  ): void {
    this.fatalMismatchHandler = handler;
  }

  /**
   * HH4 / II3 — when reconnects keep failing, probe /api/daemon-info to
   * learn the live daemon's identity, then branch on the result:
   *
   *   (a) probe fails entirely → the daemon is genuinely down. Do
   *       nothing; the reconnect timer keeps trying (real outage).
   *   (b) probe ok AND liveHash === cachedHash → same project, the WS
   *       is just flapping (e.g. daemon restart on the same port for the
   *       same project). Allow the reconnect loop to proceed.
   *   (c) probe ok AND liveHash !== cachedHash → CROSS-BIND. The daemon
   *       on this port now serves a different project. Pre-II3 (HH4) we
   *       SILENTLY rebound the tab to the live hash — switching the tab
   *       to a different project so comments/approvals could land in the
   *       wrong place. Now: set the fatalMismatch latch, stop the
   *       reconnect loop, and fire onFatalMismatch so the store surfaces
   *       a sticky "reload to re-bind" toast (mirrors the BB10 REST
   *       guard). We never setState/refreshUrl here.
   *
   * Localhost-only fetch; on (a) we fall through silently so the
   * existing reconnect timer still fires.
   */
  private async probeDaemonAndMaybeRefresh(): Promise<void> {
    let body: any;
    try {
      const host = this.baseUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
      const res = await fetch(`${host}/api/daemon-info`);
      // (a) daemon down / not answering — genuine outage. Keep reconnecting.
      if (!res.ok) return;
      body = await res.json();
    } catch {
      // (a) Probe failed entirely (daemon down, fetch rejected). The
      // reconnect timer continues; we'll try again next cycle.
      return;
    }

    const liveHash = typeof body?.projectHash === "string" ? body.projectHash : null;
    if (!liveHash) return;
    const store = (window as any).__dpConnectionStore;
    const cachedHash = store?.getState?.()?.projectHash ?? null;

    // (b) Same project — let the reconnect loop proceed unchanged.
    if (cachedHash === liveHash) return;

    // (c) Cross-bind. Latch the loop OFF and surface the mismatch instead
    // of silently rebinding to a different project.
    this.fatalMismatch = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.fatalMismatchHandler?.({
      liveProjectRoot:
        typeof body?.projectRoot === "string" ? body.projectRoot : undefined,
      liveHash,
    });
  }
}

/**
 * VS Code webview adapter — communicates via postMessage with the extension host.
 * The extension host bridges to the real WebSocket.
 */
export class VSCodeAdapter implements ConnectionAdapter {
  private vscode: any;
  private messageHandler: ((data: any) => void) | null = null;
  private connectHandler: (() => void) | null = null;
  private disconnectHandler: (() => void) | null = null;

  constructor() {
    // acquireVsCodeApi is injected by VS Code into webviews
    this.vscode = (window as any).acquireVsCodeApi?.();
  }

  connect(): void {
    if (!this.vscode) return;

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "dp:connected") {
        this.connectHandler?.();
        // Forward the initial state
        if (msg.state) {
          this.messageHandler?.({ type: "connected", state: msg.state });
        }
      } else if (msg.type === "dp:disconnected") {
        this.disconnectHandler?.();
      } else if (msg.type === "dp:message") {
        this.messageHandler?.(msg.data);
      }
    });

    // Tell extension host we're ready
    this.vscode.postMessage({ type: "dp:ready" });
  }

  disconnect(): void {
    this.vscode?.postMessage({ type: "dp:disconnect" });
  }

  onMessage(handler: (data: any) => void): void {
    this.messageHandler = handler;
  }

  onConnect(handler: () => void): void {
    this.connectHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }
}

/**
 * Get the appropriate adapter based on environment.
 */
export function createAdapter(url?: string, sessionId?: string): ConnectionAdapter {
  if ((window as any).acquireVsCodeApi) {
    return new VSCodeAdapter();
  }
  return new WebSocketAdapter(url, sessionId);
}
