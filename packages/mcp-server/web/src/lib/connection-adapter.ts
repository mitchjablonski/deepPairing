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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly maxReconnectDelay = 30000;

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
      // Auto-reconnect with exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s...
      this.reconnectAttempt++;
      const delay = Math.min(
        1000 * Math.pow(2, this.reconnectAttempt - 1),
        this.maxReconnectDelay,
      );
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
