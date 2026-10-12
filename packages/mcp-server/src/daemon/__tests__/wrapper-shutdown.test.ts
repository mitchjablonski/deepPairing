/**
 * #470 (§5) — "ended" means the registration left the daemon's live map, so
 * the wrapper's unregister must land: SIGTERM/SIGINT await it (bounded) and
 * stdin closing — how Claude Code tears down a stdio server — unregisters.
 * A real EventEmitter stands in for the process (fakes, not mocks).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installWrapperShutdown } from "../wrapper-shutdown.js";

class FakeProcess extends EventEmitter {
  readonly stdin = new EventEmitter();
  readonly exits: number[] = [];
  exit(code: number): void { this.exits.push(code); }
}

function harness(unregisterMs: number) {
  const proc = new FakeProcess();
  const order: string[] = [];
  let calls = 0;
  installWrapperShutdown({
    proc,
    log: () => {},
    timeoutMs: 100,
    unregister: () => new Promise((resolve) => {
      calls++;
      setTimeout(() => { order.push("unregistered"); resolve(); }, unregisterMs);
    }),
  });
  proc.on("SIGTERM", () => {});
  return { proc, order, calls: () => calls };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("#470 wrapper shutdown", () => {
  it("SIGTERM waits for the unregister to land before exiting", async () => {
    const h = harness(20);
    h.proc.emit("SIGTERM");
    expect(h.proc.exits).toEqual([]);
    await tick(60);
    expect(h.order).toEqual(["unregistered"]);
    expect(h.proc.exits).toEqual([0]);
  });

  it("a dead daemon can't hold the exit: the wait is bounded", async () => {
    const h = harness(10_000);
    h.proc.emit("SIGINT");
    await tick(150);
    expect(h.proc.exits).toEqual([0]);
  });

  it("closing stdin unregisters, exactly once across stdin end/close and a later signal", async () => {
    const h = harness(5);
    h.proc.stdin.emit("end");
    h.proc.stdin.emit("close");
    h.proc.emit("SIGTERM");
    await tick(40);
    expect(h.calls()).toBe(1);
    expect(h.proc.exits).toEqual([0]);
  });
});
