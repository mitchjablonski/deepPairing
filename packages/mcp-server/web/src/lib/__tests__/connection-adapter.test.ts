import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketAdapter } from "../connection-adapter";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  close(): void { this.readyState = 3; }
  emitMessage(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("WebSocketAdapter connection generations", () => {
  it("ignores callbacks from obsolete sockets after A -> B -> A", () => {
    const received: unknown[] = [];
    const adapter = new WebSocketAdapter("ws://example.test/ws", "A");
    adapter.onMessage((message) => received.push(message));
    adapter.connect();
    const firstA = FakeWebSocket.instances[0]!;
    adapter.switchSession("B");
    const b = FakeWebSocket.instances[1]!;
    adapter.switchSession("A");
    const currentA = FakeWebSocket.instances[2]!;

    firstA.emitMessage({ source: "old-A" });
    b.emitMessage({ source: "B" });
    currentA.emitMessage({ source: "current-A" });

    expect(received).toEqual([{ source: "current-A" }]);
  });
});
