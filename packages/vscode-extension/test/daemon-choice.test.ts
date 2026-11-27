import { describe, expect, it } from "vitest";
import { DAEMON_STALE_MS, chooseDaemonPort } from "../src/daemon-choice";

const NOW = 1_000_000_000;
const fresh = (port: number, ageMs = 0) => ({ port, mtimeMs: NOW - ageMs });

describe("#727 P2-1 choosing the daemon in a multi-root workspace", () => {
  it("first discovery picks the freshest daemon.json", () => {
    expect(chooseDaemonPort(null, [fresh(29001, 20_000), fresh(29002, 5_000)], NOW)).toBe(29002);
  });

  it("no candidates keeps whatever was chosen (nothing to switch to)", () => {
    expect(chooseDaemonPort(null, [], NOW)).toBeNull();
  });

  it("a heartbeat flip does not switch away from a still-fresh current daemon", () => {
    // Folder B's heartbeat just landed, so it is fresher; A is still alive.
    expect(chooseDaemonPort(29001, [fresh(29001, 25_000), fresh(29002, 0)], NOW)).toBe(29001);
    expect(chooseDaemonPort(29001, [fresh(29002, 0), fresh(29001, 1_000)], NOW)).toBe(29001);
  });

  it("switches when the current daemon.json is removed or names another port", () => {
    expect(chooseDaemonPort(29001, [fresh(29002, 10_000)], NOW)).toBe(29002);
  });

  it("switches when the current daemon.json goes stale and a fresh one exists", () => {
    expect(chooseDaemonPort(29001, [fresh(29001, DAEMON_STALE_MS + 1), fresh(29002, 1_000)], NOW)).toBe(29002);
  });

  it("keeps a stale current daemon when every candidate is stale", () => {
    const old = DAEMON_STALE_MS + 60_000;
    expect(chooseDaemonPort(29001, [fresh(29001, old + 10_000), fresh(29002, old)], NOW)).toBe(29001);
  });

  it("the same daemon advertised by two folders counts as present", () => {
    expect(chooseDaemonPort(29001, [fresh(29002, 0), fresh(29001, 1_000), fresh(29001, 50_000)], NOW)).toBe(29001);
  });

  it("a far-future mtime (clock skew) is not fresh forever and can't pin a dead daemon", () => {
    const future = { port: 29001, mtimeMs: NOW + DAEMON_STALE_MS + 1 };
    expect(chooseDaemonPort(29001, [future, fresh(29002, 1_000)], NOW)).toBe(29002);
    // A small skew inside the window still counts as fresh.
    expect(chooseDaemonPort(29001, [{ port: 29001, mtimeMs: NOW + 5_000 }, fresh(29002, 0)], NOW)).toBe(29001);
  });
});
