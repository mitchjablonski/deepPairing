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

  constructor(url?: string, private sessionId?: string) {
    const base = url ?? `ws://${window.location.host}/ws`;
    this.url = sessionId ? `${base}?sessionId=${sessionId}` : base;
  }

  /** Reconnect to a different session */
  switchSession(sessionId: string): void {
    this.sessionId = sessionId;
    const base = `ws://${window.location.host}/ws`;
    this.url = `${base}?sessionId=${sessionId}`;
    this.disconnect();
    this.connect();
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
