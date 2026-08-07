/**
 * M3 (#221) — daemon eviction-guard audit + fix.
 *
 * The round-8 dogfood had a live, registered daemon killed out from under it
 * TWICE, with NO idle-shutdown log, in the shared test port window where 5+
 * review agents (different projectRoots) collided on deterministic slots. The
 * incident asked: can one project's ensureDaemon/eviction path kill a live
 * daemon serving a DIFFERENT project in the same slot?
 *
 * The audit's verdict (proven by the scratchpad collision experiment against a
 * REAL spawned daemon, and pinned here with fakes): the AUTOMATIC path never
 * signals a foreign daemon on ANY branch — the projectRoot guard + HTTP identity
 * re-probe hold. The one real gap was FORENSIC: `waitForPortRelease`'s SIGKILL
 * escalation was unlogged and could hit a recycled pid / cross a foreign
 * takeover of the port. This file pins:
 *   1. the collision matrix (foreign-slot adopt/move; slow-foreign not killed;
 *      recycled-pid not killed; own-stale evicted WITH a loud log line);
 *   2. the SIGKILL-escalation logging + its gone-pid / foreign-takeover guards.
 *
 * FAKES not mocks: recording kill/log/probe fakes + a fake clock via injected
 * grace windows. No real SIGTERM, no real spawn.
 */
import { describe, it, expect } from "vitest";
import {
  resolveStaleDaemon,
  waitForPortRelease,
  type DaemonInfo,
} from "../daemon/lifecycle.js";

const MINE = "9.9.9"; // plugin version — always newer, so any older/absent daemon reads "stale"
const OURS = "/projects/ours";
const THEIRS = "/projects/theirs";

function makeInfo(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    pid: 5000,
    port: 21500,
    startedAt: "2026-08-07T00:00:00.000Z",
    projectRoot: OURS,
    version: "0.0.1",
    ...overrides,
  };
}

/** Recording fakes — nothing real is ever signalled. */
function recorder(
  identity: { pid: number; projectRoot: string; startedAt: string; version?: string } | null,
) {
  const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
  const released: Array<{ port: number; pid: number }> = [];
  const logs: string[] = [];
  return {
    kills,
    released,
    logs,
    deps: {
      probeIdentity: async () => identity,
      kill: (pid: number, sig: NodeJS.Signals) => kills.push({ pid, sig }),
      waitForRelease: async (port: number, pid: number) => { released.push({ port, pid }); },
      log: (m: string) => logs.push(m),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. The collision matrix — resolveStaleDaemon (the automatic ensureDaemon path)
// ---------------------------------------------------------------------------

describe("M3 (#221) — collision matrix: automatic path never signals a foreign daemon", () => {
  it("FOREIGN slot: discovery said stale+ours, live re-probe reports THEIRS → adopt, never signalled", async () => {
    // The dogfood core case: our slot is squatted by another project's daemon.
    const existing = makeInfo({ pid: 5000, port: 21500, projectRoot: OURS });
    const f = recorder({ pid: 5000, projectRoot: THEIRS, startedAt: "x", version: "0.0.1" });
    const outcome = await resolveStaleDaemon(existing, MINE, OURS, f.deps);
    expect(outcome).toBe("adopt");
    expect(f.kills).toEqual([]);
    expect(f.released).toEqual([]);
    expect(f.logs.join("\n")).toMatch(/refusing to restart/i);
  });

  it("SLOW foreign: identity re-probe times out (null) → adopt, never signalled", async () => {
    const existing = makeInfo({ pid: 5000, port: 21500 });
    const f = recorder(null); // probe fails/timeouts — foreign daemon paused (SIGSTOP)
    const outcome = await resolveStaleDaemon(existing, MINE, OURS, f.deps);
    expect(outcome).toBe("adopt");
    expect(f.kills).toEqual([]);
    expect(f.logs.join("\n")).toMatch(/could not be re-confirmed/i);
  });

  it("RECYCLED pid: live pid drifted from discovery → adopt, never signalled", async () => {
    const existing = makeInfo({ pid: 5000, port: 21500, projectRoot: OURS });
    // Same projectRoot string but a different pid ⇒ the process we discovered
    // died and the OS handed the port to a new one; must not signal.
    const f = recorder({ pid: 6001, projectRoot: OURS, startedAt: "x", version: "0.0.1" });
    const outcome = await resolveStaleDaemon(existing, MINE, OURS, f.deps);
    expect(outcome).toBe("adopt");
    expect(f.kills).toEqual([]);
  });

  it("OWN stale: pid + projectRoot re-confirmed as ours → restarted WITH a loud pre-signal log", async () => {
    const existing = makeInfo({ pid: 5000, port: 21500, projectRoot: OURS, version: "0.0.1" });
    const f = recorder({ pid: 5000, projectRoot: OURS, startedAt: "x", version: "0.0.1" });
    const outcome = await resolveStaleDaemon(existing, MINE, OURS, f.deps);
    expect(outcome).toBe("restarted");
    expect(f.kills).toEqual([{ pid: 5000, sig: "SIGTERM" }]);
    // The forensic line names the exact target + reason BEFORE the signal.
    const joined = f.logs.join("\n");
    expect(joined).toMatch(/restarting stale daemon: pid 5000 on :21500 for project \/projects\/ours/);
    expect(joined).toMatch(/sending SIGTERM/);
  });
});

// ---------------------------------------------------------------------------
// 2. waitForPortRelease — the SIGKILL escalation: logged + guarded
// ---------------------------------------------------------------------------

describe("M3 (#221) — waitForPortRelease SIGKILL escalation is logged + guarded", () => {
  // graceMs:0 skips the grace loop immediately (Date.now() < Date.now()+0 is
  // false), so each case lands straight on the escalation decision. pidGone +
  // probeIdentity are injected so the branch is deterministic regardless of
  // host pid state — no real signal ever reaches a real process.
  const base = { graceMs: 0, killWaitMs: 0, expectedProjectRoot: OURS };

  it("alive-and-ours (pid alive, no foreign takeover) → logs BEFORE SIGKILL, then SIGKILLs", async () => {
    const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const logs: string[] = [];
    await waitForPortRelease(21500, 7000, {
      ...base,
      kill: (pid, sig) => kills.push({ pid, sig }),
      log: (m) => logs.push(m),
      pidGone: () => false, // our SIGTERM'd daemon is wedged, still alive
      probeIdentity: async () => null, // no daemon answers ⇒ not a foreign takeover
    });
    expect(kills).toEqual([{ pid: 7000, sig: "SIGKILL" }]);
    const joined = logs.join("\n");
    expect(joined).toMatch(/escalating to SIGKILL/);
    expect(joined).toMatch(/pid 7000/);
    expect(joined).toMatch(/21500/);
  });

  it("GONE pid + port taken over by a FOREIGN daemon → NOT escalated, logs the takeover", async () => {
    const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const logs: string[] = [];
    await waitForPortRelease(21500, 7000, {
      ...base,
      kill: (pid, sig) => kills.push({ pid, sig }),
      log: (m) => logs.push(m),
      pidGone: () => true, // our SIGTERM'd daemon is gone — pid may be recycled
      probeIdentity: async () => ({ pid: 8123, projectRoot: THEIRS }),
    });
    expect(kills).toEqual([]);
    expect(logs.join("\n")).toMatch(/already gone/i);
    expect(logs.join("\n")).toMatch(/foreign\/fresh owner/i);
  });

  it("GONE pid + nothing answers the port → NOT escalated (never SIGKILL a dead/recycled pid)", async () => {
    const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const logs: string[] = [];
    await waitForPortRelease(21500, 7000, {
      ...base,
      kill: (pid, sig) => kills.push({ pid, sig }),
      log: (m) => logs.push(m),
      pidGone: () => true,
      probeIdentity: async () => null,
    });
    expect(kills).toEqual([]);
    expect(logs.join("\n")).toMatch(/already gone/i);
    expect(logs.join("\n")).toMatch(/recycled pid/i);
  });

  it("alive pid but a FOREIGN daemon now answers the port → NOT escalated (foreign takeover of our slot)", async () => {
    const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const logs: string[] = [];
    await waitForPortRelease(21500, 7000, {
      ...base,
      kill: (pid, sig) => kills.push({ pid, sig }),
      log: (m) => logs.push(m),
      pidGone: () => false, // our pid still shows alive...
      probeIdentity: async () => ({ pid: 8123, projectRoot: THEIRS }), // ...but a squatter owns the port
    });
    expect(kills).toEqual([]);
    expect(logs.join("\n")).toMatch(/foreign takeover/i);
  });
});
