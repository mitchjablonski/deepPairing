/**
 * Refused reconnects must LATCH, not loop.
 *
 * The daemon answers an unservable session by completing the WebSocket
 * upgrade, sending one `connection_refused` frame, then closing 1011. To a
 * loop that only watches `close`, that is indistinguishable from a flap — and
 * because `onopen` resets the backoff counter, every refused attempt re-armed
 * the MINIMUM delay. Measured against a real refusing daemon before the fix:
 * six consecutive attempts, all `opened: true`, all close 1011, all arming
 * 1000ms — an unbounded once-a-second retry with nothing on screen.
 *
 * These tests drive the real WebSocketAdapter through a fake socket (fakes,
 * not mocks: the fake implements the browser surface the adapter actually
 * uses) and pin the three properties the fix owes: the loop stops, the reason
 * reaches the caller, and the tab can still get back in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketAdapter, type ConnectionRefusal } from "../connection-adapter";

const REFUSAL = {
  type: "connection_refused",
  code: "session_review_conflict",
  sessionId: "frozen",
  message: "Session state requires review before reconnecting.",
};

/** Minimal stand-in for the browser WebSocket, driven by the test. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!ws) throw new Error("no socket was constructed");
    return ws;
  }

  /**
   * When set, every socket this class mints replays the daemon's refusal
   * (upgrade → `connection_refused` → 1011) on the next tick — so advancing
   * fake time reproduces the real retry storm rather than stalling on a
   * half-open fake.
   */
  static autoRefuse: Record<string, unknown> | null = null;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closedByClient = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    const frame = FakeWebSocket.autoRefuse;
    if (frame) {
      setTimeout(() => {
        this.serverOpen();
        this.serverSend(frame);
        this.serverClose();
      }, 0);
    }
  }

  /** Client-initiated close (adapter.disconnect / onerror). */
  close(): void {
    this.closedByClient = true;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  // --- test drivers -------------------------------------------------------
  /** The upgrade completes — this is where the adapter resets its backoff. */
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSend(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  /** The daemon drops us (e.g. 1011 after a refusal, or an ordinary flap). */
  serverClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  serverError(): void {
    this.onerror?.();
  }
  queuedClose(): void {
    this.onclose?.();
  }
}

/** One full refuse cycle: upgrade, refusal frame, 1011. */
function refuseOnce(frame: Record<string, unknown> = REFUSAL): void {
  const ws = FakeWebSocket.last;
  ws.serverOpen();
  ws.serverSend(frame);
  ws.serverClose();
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.autoRefuse = null;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  // The HH4 stale-tab probe fires after 3 failed connects; keep it offline so
  // the control test exercises reconnect, not the mismatch branch.
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WebSocketAdapter — refused reconnects", () => {
  it("latches the loop after one refusal instead of retrying forever", () => {
    // Deliberately registers NO handler: the property under test is the loop
    // itself. The daemon refuses EVERY attempt, exactly as a frozen session
    // does. Pre-fix this reached 301 sockets over the same five minutes — one
    // per second, unbounded, with nothing on screen.
    FakeWebSocket.autoRefuse = REFUSAL;
    const adapter = new WebSocketAdapter("ws://127.0.0.1:9/ws", "frozen");
    adapter.connect();

    vi.advanceTimersByTime(300_000); // five minutes of wall clock

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("hands the daemon's reason and blamed session to the caller", () => {
    const adapter = new WebSocketAdapter("ws://127.0.0.1:9/ws", "frozen");
    const seen: ConnectionRefusal[] = [];
    adapter.onConnectionRefused((info) => seen.push(info));
    adapter.connect();

    refuseOnce();

    expect(seen).toEqual([
      {
        code: "session_review_conflict",
        sessionId: "frozen",
        message: "Session state requires review before reconnecting.",
      },
    ]);
  });

  it("carries the blamed sessionId through even when it is not this tab's session", () => {
    // The global client subscribes to every session; the daemon names the one
    // it could not read so the UI cannot blank an unrelated session.
    const adapter = new WebSocketAdapter("ws://127.0.0.1:9/ws");
    const seen: ConnectionRefusal[] = [];
    adapter.onConnectionRefused((info) => seen.push(info));
    adapter.connect();

    refuseOnce({ ...REFUSAL, sessionId: "other-session" });
    vi.advanceTimersByTime(300_000);

    expect(seen[0]?.sessionId).toBe("other-session");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reports no session when the daemon could not attribute the failure", () => {
    const adapter = new WebSocketAdapter("ws://127.0.0.1:9/ws");
    const seen: ConnectionRefusal[] = [];
    adapter.onConnectionRefused((info) => seen.push(info));
    adapter.connect();

    refuseOnce({ type: "connection_refused", message: "Session state is temporarily unavailable." });

    expect(seen).toEqual([
      { code: undefined, sessionId: undefined, message: "Session state is temporarily unavailable." },
    ]);
  });

  it("keeps generic snapshot failures recoverable with bounded backoff", () => {
    const adapter = new WebSocketAdapter("ws://127.0.0.1:9/ws", "broken");
    adapter.connect();

    refuseOnce({ type: "connection_refused", message: "private detail" });
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    refuseOnce({ type: "connection_refused" });
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("CONTROL — an ordinary post-open drop still reconnects", () => {
    // Guards the fix against over-reach: the latch must key on the refusal
    // frame, not on "closed after opening". This also documents the mechanism
    // that made the refusal loop so tight — onopen resets the backoff, so a
    // repeating post-open close re-arms 1000ms every time.
    const adapter = new WebSocketAdapter("ws://127.0.0.1:9/ws", "healthy");
    adapter.connect();

    for (let i = 0; i < 3; i++) {
      const ws = FakeWebSocket.last;
      ws.serverOpen();
      ws.serverSend({ type: "connected", state: {} });
      ws.serverClose();
      vi.advanceTimersByTime(999);
      expect(FakeWebSocket.instances).toHaveLength(i + 1); // not yet
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(i + 2); // re-armed at 1000ms
    }
  });

  it("retryAfterRefusal makes exactly one deliberate attempt and re-latches if still refused", () => {
    const adapter = new WebSocketAdapter("ws://127.0.0.1:9/ws", "frozen");
    const seen: ConnectionRefusal[] = [];
    adapter.onConnectionRefused((info) => seen.push(info));
    adapter.connect();

    refuseOnce();
    vi.advanceTimersByTime(300_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    adapter.retryAfterRefusal();
    expect(FakeWebSocket.instances).toHaveLength(2);

    refuseOnce(); // the human retried too early — still refused
    vi.advanceTimersByTime(300_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(seen).toHaveLength(2);
  });

  it("a legitimate reconnect after the conflict is resolved still succeeds", () => {
    const adapter = new WebSocketAdapter("ws://127.0.0.1:9/ws", "frozen");
    let connects = 0;
    adapter.onConnect(() => connects++);
    adapter.onConnectionRefused(() => {});
    adapter.connect();

    refuseOnce();
    vi.advanceTimersByTime(300_000);

    // Human clears the conflict in the UI, then hits Retry.
    adapter.retryAfterRefusal();
    const healthy = FakeWebSocket.last;
    healthy.serverOpen();
    const messages: unknown[] = [];
    adapter.onMessage((data) => messages.push(data));
    healthy.serverSend({ type: "connected", state: {} });

    expect(connects).toBe(2); // the refused open, then the good one
    expect(messages).toEqual([{ type: "connected", state: {} }]);

    // And the normal reconnect loop is armed again, not stuck off.
    healthy.serverClose();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("switching sessions clears a refusal latched on the old one", () => {
    const adapter = new WebSocketAdapter("ws://127.0.0.1:9/ws", "frozen");
    adapter.onConnectionRefused(() => {});
    adapter.connect();
    refuseOnce();
    vi.advanceTimersByTime(300_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    adapter.switchSession("healthy");
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.last.url).toContain("sessionId=healthy");

    const ws = FakeWebSocket.last;
    ws.serverOpen();
    ws.serverClose();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it.each(["before", "after"])(
    "ignores a replaced socket's late refusal/close/error %s healthy hydration",
    (timing) => {
      const adapter = new WebSocketAdapter("ws://127.0.0.1:9/ws", "frozen");
      const refusals: ConnectionRefusal[] = [];
      const messages: unknown[] = [];
      let disconnects = 0;
      adapter.onConnectionRefused((info) => refusals.push(info));
      adapter.onMessage((message) => messages.push(message));
      adapter.onDisconnect(() => { disconnects++; });
      adapter.connect();

      const old = FakeWebSocket.last;
      old.serverOpen();
      adapter.switchSession("healthy");
      const healthy = FakeWebSocket.last;
      healthy.serverOpen();
      const disconnectsAfterSwitch = disconnects;

      const deliverOldEvents = () => {
        old.serverSend(REFUSAL);
        old.queuedClose();
        old.serverError();
      };
      if (timing === "before") deliverOldEvents();
      healthy.serverSend({ type: "connected", state: { sessionId: "healthy", artifacts: [{ id: "healthy" }] } });
      if (timing === "after") deliverOldEvents();

      expect(refusals).toEqual([]);
      expect(disconnects).toBe(disconnectsAfterSwitch);
      expect(messages).toEqual([{ type: "connected", state: { sessionId: "healthy", artifacts: [{ id: "healthy" }] } }]);

      healthy.serverClose();
      expect(disconnects).toBe(disconnectsAfterSwitch + 1);
      vi.advanceTimersByTime(1000);
      expect(FakeWebSocket.instances).toHaveLength(3);
    },
  );
});
