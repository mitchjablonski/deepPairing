/**
 * #727 — the extension-host side of the webview's daemon connection.
 *
 * Pure (no `vscode` or `ws` import; both are injected) so it is unit-testable.
 *
 * - Every `dp:ready` from the webview (first load, a hide/show reload, "Reload
 *   Webviews", a rebuild after the daemon moved) drops any open socket and
 *   reconnects, so the daemon replays its snapshot to the fresh document. A
 *   bare `dp:connected` on the old socket would show "connected" with nothing
 *   loaded.
 * - Each socket's handlers act only while it is still the current socket, so
 *   late `message`/`close`/`error` events from a replaced socket never reach
 *   the new document or schedule a reconnect.
 */

/** The slice of a `ws` WebSocket the bridge uses. */
export interface BridgeSocket {
  readonly readyState: number;
  on(event: "open" | "close" | "error", fn: () => void): void;
  on(event: "message", fn: (data: { toString(): string }) => void): void;
  close(): void;
}

export interface DaemonBridgeDeps {
  createSocket(url: string): BridgeSocket;
  /** The WS URL for the current daemon (may fetch its project hash). */
  resolveUrl(): Promise<string>;
  /** Post to the webview. */
  post(msg: unknown): void;
  /** Called with each parsed daemon message (VS Code notifications). */
  onDaemonMessage?(msg: Record<string, unknown>): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

const CONNECTING = 0;
const OPEN = 1;

export class DaemonBridge {
  private ws?: BridgeSocket;
  /** Bumped whenever the current socket is dropped; stale async work checks it. */
  private generation = 0;
  private resolving = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: unknown;
  /** Set by disconnect() — suppresses auto-reconnect until the next ready(). */
  private disposed = false;

  constructor(private readonly deps: DaemonBridgeDeps) {}

  /** The webview (re)loaded: reconnect so the daemon replays its snapshot. */
  ready(): void {
    this.disposed = false;
    if (this.ws) this.drop();
    this.connect();
  }

  /** Stop: close the socket and never auto-reconnect until ready(). */
  disconnect(): void {
    this.disposed = true;
    this.drop();
  }

  private connect(): void {
    if (this.disposed || this.resolving) return;
    if (this.ws && (this.ws.readyState === CONNECTING || this.ws.readyState === OPEN)) return;
    const gen = this.generation;
    this.resolving = true;
    void this.deps.resolveUrl().then(
      (url) => {
        if (gen !== this.generation) return;
        this.resolving = false;
        if (!this.disposed) this.open(url);
      },
      () => {
        if (gen !== this.generation) return;
        this.resolving = false;
        this.scheduleReconnect();
      },
    );
  }

  private open(url: string): void {
    let ws: BridgeSocket;
    try {
      ws = this.deps.createSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.deps.post({ type: "dp:connected" });
    });
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      this.deps.post({ type: "dp:message", data: parsed });
      if (parsed && typeof parsed === "object") this.deps.onDaemonMessage?.(parsed as Record<string, unknown>);
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.deps.post({ type: "dp:disconnected" });
      this.scheduleReconnect();
    });
    ws.on("error", () => {
      if (this.ws !== ws) return;
      ws.close();
    });
  }

  private drop(): void {
    this.generation++;
    this.resolving = false;
    this.clearReconnect();
    const ws = this.ws;
    this.ws = undefined;
    try { ws?.close(); } catch { /* already gone */ }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.clearReconnect();
    this.reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), 30000);
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.reconnectTimer = set(() => {
      this.reconnectTimer = undefined;
      if (!this.disposed) this.connect();
    }, delay);
  }
}
