import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { guardWatcher, safeHeartbeatTick, HEARTBEAT_ESCALATE_AFTER, type HeartbeatState } from "../watchdog.js";

/**
 * H1-2 / H1-3 — two crash vectors that could uncaughtException → exit(1) an
 * otherwise-healthy daemon. Both tests use REAL fakes: a real Node
 * EventEmitter standing in for the fs.watch FSWatcher (it has the exact
 * throw-on-unhandled-'error' semantics we're defending against), and a real
 * throwing function for the heartbeat tick — no mocking framework.
 */

/** A real EventEmitter with the FSWatcher's close() surface. Faithful fake:
 *  an unhandled 'error' emit throws, exactly like a live fs.watch watcher. */
class FakeWatcher extends EventEmitter {
  closed = false;
  close() {
    this.closed = true;
  }
}

describe("H1-2 — guardWatcher keeps a watcher 'error' from killing the process", () => {
  it("an emitted 'error' does NOT throw once guarded (pre-fix this crashed the daemon)", () => {
    const raw = new FakeWatcher();
    // Baseline: an UNGUARDED watcher rethrows an unhandled 'error' — the exact
    // path that reaches uncaughtException → exit(1) in the daemon.
    expect(() => raw.emit("error", new Error("EMFILE: inotify limit"))).toThrow();

    const watcher = new FakeWatcher();
    const logs: string[] = [];
    guardWatcher(watcher, (m) => logs.push(m));

    const err = Object.assign(new Error("inotify watch limit"), { code: "ENOSPC" });
    expect(() => watcher.emit("error", err)).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("ENOSPC");
    // Degrades gracefully: the watcher is closed so we stop leaning on a dead
    // watch, but the daemon lives on.
    expect(watcher.closed).toBe(true);
  });

  it("logs ONCE even if a broken watch re-emits 'error'", () => {
    const watcher = new FakeWatcher();
    const logs: string[] = [];
    guardWatcher(watcher, (m) => logs.push(m));
    expect(() => {
      watcher.emit("error", new Error("first"));
      watcher.emit("error", new Error("second"));
    }).not.toThrow();
    expect(logs).toHaveLength(1);
  });
});

describe("H1-3 — safeHeartbeatTick keeps a throwing periodic write from killing the process", () => {
  it("a throwing writeDaemonInfo tick does NOT propagate (pre-fix this exit(1)'d the daemon)", () => {
    const logs: string[] = [];
    const throwingTick = () => {
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    };
    // The setInterval callback must never throw — a throw here is uncaught.
    expect(() => safeHeartbeatTick(throwingTick, (m) => logs.push(m))).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("ENOSPC");
  });

  it("a healthy tick runs and logs nothing", () => {
    const logs: string[] = [];
    let ran = 0;
    safeHeartbeatTick(() => { ran++; }, (m) => logs.push(m));
    expect(ran).toBe(1);
    expect(logs).toHaveLength(0);
  });
});

describe("H2-3 (#146) — heartbeat escalates a PERSISTENT write failure to stderr", () => {
  const throwing = () => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  };

  it("stays silent-ish for the first N-1 failures, then escalates ONCE at the threshold", () => {
    const logs: string[] = [];
    const escalations: string[] = [];
    const state: HeartbeatState = { consecutiveFailures: 0 };
    // First N-1 failures: routine per-tick log only, no stderr escalation.
    for (let i = 0; i < HEARTBEAT_ESCALATE_AFTER - 1; i++) {
      safeHeartbeatTick(throwing, (m) => logs.push(m), state, (m) => escalations.push(m));
    }
    expect(escalations).toHaveLength(0);
    expect(state.consecutiveFailures).toBe(HEARTBEAT_ESCALATE_AFTER - 1);

    // The Nth consecutive failure escalates exactly once (pre-fix: never).
    safeHeartbeatTick(throwing, (m) => logs.push(m), state, (m) => escalations.push(m));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain("consecutive heartbeats");
    expect(escalations[0]).toContain("ENOSPC");

    // Further consecutive failures do NOT re-spam stderr.
    safeHeartbeatTick(throwing, (m) => logs.push(m), state, (m) => escalations.push(m));
    expect(escalations).toHaveLength(1);
    // Every failed tick still emits the routine per-tick log.
    expect(logs).toHaveLength(HEARTBEAT_ESCALATE_AFTER + 1);
  });

  it("a success resets the consecutive-failure counter so a later streak re-escalates", () => {
    const escalations: string[] = [];
    const state: HeartbeatState = { consecutiveFailures: 0 };
    for (let i = 0; i < HEARTBEAT_ESCALATE_AFTER; i++) {
      safeHeartbeatTick(throwing, () => {}, state, (m) => escalations.push(m));
    }
    expect(escalations).toHaveLength(1);
    // A healthy tick clears the streak.
    safeHeartbeatTick(() => {}, () => {}, state, (m) => escalations.push(m));
    expect(state.consecutiveFailures).toBe(0);
    // A fresh streak escalates again.
    for (let i = 0; i < HEARTBEAT_ESCALATE_AFTER; i++) {
      safeHeartbeatTick(throwing, () => {}, state, (m) => escalations.push(m));
    }
    expect(escalations).toHaveLength(2);
  });
});
