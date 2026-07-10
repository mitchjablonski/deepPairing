import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { guardWatcher, safeHeartbeatTick } from "../watchdog.js";

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
