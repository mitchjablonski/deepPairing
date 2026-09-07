import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketAdapter } from "./connection-adapter";

class ControlledWebSocket {
  static instances: ControlledWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    ControlledWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  closed() {
    this.readyState = 3;
    this.onclose?.();
  }

  error() {
    this.onerror?.();
  }
}

describe("WebSocketAdapter socket ownership", () => {
  beforeEach(() => {
    ControlledWebSocket.instances = [];
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    delete (window as any).__dpConnectionStore;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as any).__dpConnectionStore;
  });

  it("ignores every callback from a socket replaced during URL refresh", () => {
    vi.useFakeTimers();
    const adapter = new WebSocketAdapter("ws://localhost/ws", "session-a");
    const connects = vi.fn();
    const disconnects = vi.fn();
    const messages = vi.fn();
    adapter.onConnect(connects);
    adapter.onDisconnect(disconnects);
    adapter.onMessage(messages);

    adapter.connect();
    const first = ControlledWebSocket.instances[0]!;
    (window as any).__dpConnectionStore = {
      getState: () => ({ projectHash: "project-a" }),
    };
    adapter.refreshUrl();
    const second = ControlledWebSocket.instances[1]!;

    second.open();
    second.message({ type: "connected", state: { sessionId: "session-a" } });
    first.open();
    first.message({ type: "artifact_created", artifact: { id: "stale" } });
    first.error();
    first.closed();
    vi.runAllTimers();

    expect(connects).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledWith({
      type: "connected",
      state: { sessionId: "session-a" },
    });
    expect(disconnects).not.toHaveBeenCalled();
    expect(ControlledWebSocket.instances).toHaveLength(2);
  });

  it("retires a deliberate disconnect before a synchronous close callback", () => {
    vi.useFakeTimers();
    const adapter = new WebSocketAdapter("ws://localhost/ws");
    const disconnects = vi.fn();
    adapter.onDisconnect(disconnects);
    adapter.connect();
    const socket = ControlledWebSocket.instances[0]!;
    socket.close = () => {
      socket.readyState = 3;
      socket.onclose?.();
    };

    adapter.disconnect();
    vi.runAllTimers();

    expect(disconnects).not.toHaveBeenCalled();
    expect(ControlledWebSocket.instances).toHaveLength(1);
  });

  it("notifies and reconnects after the current socket closes", () => {
    vi.useFakeTimers();
    const adapter = new WebSocketAdapter("ws://localhost/ws");
    const disconnects = vi.fn();
    adapter.onDisconnect(disconnects);
    adapter.connect();

    ControlledWebSocket.instances[0]!.closed();
    expect(disconnects).toHaveBeenCalledTimes(1);
    expect(ControlledWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(ControlledWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ControlledWebSocket.instances).toHaveLength(2);
  });

  it("cancels a closed socket's backoff when an explicit successor connects", () => {
    vi.useFakeTimers();
    const adapter = new WebSocketAdapter("ws://localhost/ws");
    adapter.connect();
    ControlledWebSocket.instances[0]!.closed();

    adapter.connect();
    expect(ControlledWebSocket.instances).toHaveLength(2);
    vi.runAllTimers();

    expect(ControlledWebSocket.instances).toHaveLength(2);
  });

  it.each([
    ["fetch", "connect"],
    ["fetch", "disconnect"],
    ["json", "connect"],
    ["json", "disconnect"],
  ] as const)("does not let a mismatch probe paused at %s poison a later %s", async (boundary, action) => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    let resolveJson!: (body: unknown) => void;
    const json = vi.fn(() => new Promise<unknown>((resolve) => {
      resolveJson = resolve;
    }));
    const response = new Response(null, { status: 200 });
    response.json = json;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));
    (window as any).__dpConnectionStore = {
      getState: () => ({ projectHash: "project-a" }),
    };
    const adapter = new WebSocketAdapter("ws://localhost/ws");
    const mismatches = vi.fn();
    adapter.onFatalMismatch(mismatches);
    adapter.connect();

    for (let attempt = 0; attempt < 2; attempt++) {
      ControlledWebSocket.instances.at(-1)!.closed();
      await vi.runOnlyPendingTimersAsync();
    }
    ControlledWebSocket.instances.at(-1)!.closed();
    expect(fetch).toHaveBeenCalledTimes(1);

    if (boundary === "json") {
      resolveFetch(response);
      await vi.waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    }
    if (action === "connect") adapter.connect();
    else adapter.disconnect();
    const socketCountAfterAction = ControlledWebSocket.instances.length;
    if (boundary === "fetch") {
      resolveFetch(response);
      await vi.waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    }
    resolveJson({ projectHash: "project-b" });
    await vi.runAllTimersAsync();

    expect(mismatches).not.toHaveBeenCalled();
    expect(ControlledWebSocket.instances).toHaveLength(socketCountAfterAction);
  });

  it("stops the old close path when onDisconnect synchronously connects a successor", () => {
    vi.useFakeTimers();
    const adapter = new WebSocketAdapter("ws://localhost/ws");
    let reconnectInHandler = true;
    adapter.onDisconnect(() => {
      if (reconnectInHandler) {
        reconnectInHandler = false;
        adapter.connect();
      }
    });
    adapter.connect();

    ControlledWebSocket.instances[0]!.closed();
    expect(ControlledWebSocket.instances).toHaveLength(2);
    vi.runAllTimers();
    expect(ControlledWebSocket.instances).toHaveLength(2);

    ControlledWebSocket.instances[1]!.closed();
    vi.advanceTimersByTime(999);
    expect(ControlledWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(ControlledWebSocket.instances).toHaveLength(3);
  });
});
