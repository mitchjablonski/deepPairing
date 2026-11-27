import { describe, expect, it } from "vitest";
import { DaemonBridge, type BridgeSocket } from "../src/daemon-bridge";

/** A fake `ws` socket driven by the test (implements the surface the bridge uses). */
class FakeSocket implements BridgeSocket {
  readyState = 0;
  closed = false;
  private handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  constructor(readonly url: string) {}
  on(event: string, fn: (arg?: never) => void): void {
    (this.handlers[event] ??= []).push(fn as (arg?: unknown) => void);
  }
  close(): void { this.closed = true; this.readyState = 2; }
  emit(event: string, arg?: unknown): void {
    if (event === "open") this.readyState = 1;
    if (event === "close") this.readyState = 3;
    for (const fn of this.handlers[event] ?? []) fn(arg);
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const posted: unknown[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const bridge = new DaemonBridge({
    createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    resolveUrl: () => Promise.resolve("ws://localhost:29001/ws"),
    post: (m) => posted.push(m),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { bridge, sockets, posted, timers, flush };
}

describe("#727 DaemonBridge", () => {
  it("dp:ready connects and forwards daemon messages", async () => {
    const h = harness();
    h.bridge.ready();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0]!.emit("open");
    h.sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "connected", state: {} })));
    expect(h.posted).toEqual([{ type: "dp:connected" }, { type: "dp:message", data: { type: "connected", state: {} } }]);
  });

  it("P2-2: dp:ready on an OPEN socket reconnects (fresh snapshot), never a bare dp:connected", async () => {
    const h = harness();
    h.bridge.ready();
    await h.flush();
    h.sockets[0]!.emit("open");
    h.posted.length = 0;

    // The webview reloaded (hide/show, Reload Webviews) while the socket stayed open.
    h.bridge.ready();
    expect(h.posted).toEqual([]);
    expect(h.sockets[0]!.closed).toBe(true);
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.emit("open");
    expect(h.posted).toEqual([{ type: "dp:connected" }]);
  });

  it("P3: late events from a replaced socket never reach the new document", async () => {
    const h = harness();
    h.bridge.ready();
    await h.flush();
    const old = h.sockets[0]!;
    old.emit("open");
    h.bridge.ready();
    await h.flush();
    h.posted.length = 0;
    const timersBefore = h.timers.length;

    old.emit("message", Buffer.from(JSON.stringify({ type: "stale" })));
    old.emit("error");
    old.emit("close");
    expect(h.posted).toEqual([]);
    expect(h.timers.length).toBe(timersBefore); // no reconnect scheduled by the old socket
  });

  it("a close on the live socket reports and schedules a backoff reconnect", async () => {
    const h = harness();
    h.bridge.ready();
    await h.flush();
    h.sockets[0]!.emit("open");
    h.posted.length = 0;
    h.sockets[0]!.emit("close");
    expect(h.posted).toEqual([{ type: "dp:disconnected" }]);
    expect(h.timers.at(-1)?.ms).toBe(1000);
    h.timers.at(-1)!.fn();
    await h.flush();
    expect(h.sockets).toHaveLength(2);
  });

  it("disconnect stops reconnects and ignores the closing socket", async () => {
    const h = harness();
    h.bridge.ready();
    await h.flush();
    h.sockets[0]!.emit("open");
    h.posted.length = 0;
    h.bridge.disconnect();
    h.sockets[0]!.emit("close");
    expect(h.posted).toEqual([]);
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0);
  });

  it("a dp:ready while the URL is still resolving opens only one socket", async () => {
    const h = harness();
    h.bridge.ready();
    h.bridge.ready();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
  });
});
