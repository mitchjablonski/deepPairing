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
import { spawn } from "node:child_process";
import {
  resolveStaleDaemon,
  waitForPortRelease,
  readProcessStartTime,
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

describe("M3-F1 (#221) — waitForPortRelease SIGKILL escalation: logged + start-time-guarded", () => {
  // graceMs:0 skips the grace loop immediately (Date.now() < Date.now()+0 is
  // false), so each case lands straight on the escalation decision. pidGone +
  // readStartTime + probeIdentity are injected so the branch is deterministic
  // regardless of host pid state — no real signal ever reaches a real process.
  const base = { graceMs: 0, killWaitMs: 0, expectedProjectRoot: OURS };
  const TICK = "163969165"; // an opaque /proc starttime token

  it("wedged-and-ours (pid alive, start-time UNCHANGED) → logs BEFORE SIGKILL, then SIGKILLs", async () => {
    const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const logs: string[] = [];
    await waitForPortRelease(21500, 7000, {
      ...base,
      kill: (pid, sig) => kills.push({ pid, sig }),
      log: (m) => logs.push(m),
      pidGone: () => false, // our SIGTERM'd daemon is wedged, still alive
      targetStartTime: TICK, // baseline captured at identity-confirm
      readStartTime: () => TICK, // live start-time still matches ⇒ same process
    });
    expect(kills).toEqual([{ pid: 7000, sig: "SIGKILL" }]);
    const joined = logs.join("\n");
    expect(joined).toMatch(/escalating to SIGKILL/);
    expect(joined).toMatch(/start-time is unchanged/);
    expect(joined).toMatch(/pid 7000/);
    expect(joined).toMatch(/21500/);
  });

  it("F1 repro — RECYCLED-ALIVE pid (alive, start-time CHANGED) → NOT killed, refusal logged", async () => {
    // The reviewer's TEST5: our SIGTERM'd daemon exited, the OS recycled the
    // integer into an unrelated LIVE process (a throwaway `sleep 600`) within
    // the grace window. pidGone is false, but the start-time no longer matches
    // the baseline ⇒ it is NOT our daemon ⇒ must never SIGKILL it.
    const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const logs: string[] = [];
    await waitForPortRelease(21500, 7000, {
      ...base,
      kill: (pid, sig) => kills.push({ pid, sig }),
      log: (m) => logs.push(m),
      pidGone: () => false, // the recycled process is alive
      targetStartTime: TICK, // our daemon's baseline
      readStartTime: () => "999999999", // the recycled process started later ⇒ different token
    });
    expect(kills).toEqual([]);
    const joined = logs.join("\n");
    expect(joined).toMatch(/NOT escalating to SIGKILL/);
    expect(joined).toMatch(/cannot prove it is still our SIGTERM'd daemon/);
    expect(joined).toMatch(/may have been recycled/i);
  });

  it("start-time UNREADABLE now (alive, live read null) → NOT killed (unverifiable ⇒ fail-safe)", async () => {
    const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const logs: string[] = [];
    await waitForPortRelease(21500, 7000, {
      ...base,
      kill: (pid, sig) => kills.push({ pid, sig }),
      log: (m) => logs.push(m),
      pidGone: () => false,
      targetStartTime: TICK,
      readStartTime: () => null, // live start-time unreadable ⇒ can't prove identity
    });
    expect(kills).toEqual([]);
    expect(logs.join("\n")).toMatch(/now=unreadable/);
  });

  it("NO baseline captured (targetStartTime null) → NOT killed (never signal on pid alone)", async () => {
    const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const logs: string[] = [];
    await waitForPortRelease(21500, 7000, {
      ...base,
      kill: (pid, sig) => kills.push({ pid, sig }),
      log: (m) => logs.push(m),
      pidGone: () => false,
      targetStartTime: null, // confirm-time read failed ⇒ no baseline
      readStartTime: () => TICK,
    });
    expect(kills).toEqual([]);
    expect(logs.join("\n")).toMatch(/baseline=unreadable/);
  });

  it("GONE pid + port taken over by a FOREIGN daemon → NOT escalated, forensic takeover logged", async () => {
    const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const logs: string[] = [];
    await waitForPortRelease(21500, 7000, {
      ...base,
      kill: (pid, sig) => kills.push({ pid, sig }),
      log: (m) => logs.push(m),
      pidGone: () => true, // our SIGTERM'd daemon exited — pid is now free
      probeIdentity: async () => ({ pid: 8123, projectRoot: THEIRS }),
      readStartTime: () => TICK, // never consulted on the gone-pid path
    });
    expect(kills).toEqual([]);
    expect(logs.join("\n")).toMatch(/has exited/i);
    expect(logs.join("\n")).toMatch(/may have been recycled/i);
  });

  it("GONE pid + nothing answers the port → NOT escalated (never SIGKILL a freed pid)", async () => {
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
    expect(logs.join("\n")).toMatch(/has exited/i);
    expect(logs.join("\n")).toMatch(/gone \(and may be recycled\)/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Executed repro — the REAL /proc start-time reader against a REAL process
// ---------------------------------------------------------------------------

const startTimeReadable = readProcessStartTime(process.pid) !== null;

describe("M3-F1 (#221) — real /proc start-time reader protects a recycled-ALIVE pid", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  it("reads a stable, opaque token for a live process", () => {
    if (!startTimeReadable) return; // non-/proc host (e.g. macOS w/o ps) — covered by the fake-injected suite
    const a = readProcessStartTime(process.pid);
    const b = readProcessStartTime(process.pid);
    expect(a).not.toBeNull();
    expect(a).toBe(b); // stable across reads
    expect(readProcessStartTime(2147480000)).toBeNull(); // almost-certainly-free pid ⇒ unreadable
  });

  it("TEST5 shape: a live process whose start-time ≠ the daemon's baseline is NOT SIGKILLed (real reader)", async () => {
    if (!startTimeReadable) return;
    // Stand-in for "the OS recycled our dead daemon's pid into an unrelated live
    // process": a throwaway sleeper. Its REAL start-time will not match the
    // bogus baseline we pass, so the guard must refuse to escalate — using the
    // production readProcessStartTime (no injection), a real kill fn, and a real
    // pidGone check.
    const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
    try {
      // Let it register a pid.
      for (let i = 0; i < 50 && sleeper.pid === undefined; i++) await sleep(10);
      const recycledPid = sleeper.pid!;
      expect(pidAlive(recycledPid)).toBe(true);

      const logs: string[] = [];
      let realKills = 0;
      await waitForPortRelease(21500, recycledPid, {
        graceMs: 0,
        killWaitMs: 0,
        expectedProjectRoot: OURS,
        // A baseline that does NOT match the sleeper's real start-time — as if
        // our daemon (now dead) had once held this pid at a different time.
        targetStartTime: "1", // no real process starts at tick 1
        // production readProcessStartTime + a real-signal kill, so a regression
        // that dropped the guard would actually kill the innocent sleeper.
        kill: (pid, sig) => { realKills++; try { process.kill(pid, sig); } catch { /* gone */ } },
        log: (m) => logs.push(m),
      });

      expect(realKills).toBe(0);
      expect(pidAlive(recycledPid)).toBe(true); // the innocent survived
      expect(logs.join("\n")).toMatch(/cannot prove it is still our SIGTERM'd daemon/);
    } finally {
      try { sleeper.kill("SIGKILL"); } catch { /* gone */ }
    }
  });

  it("legitimate escalation: baseline == the process's REAL start-time → SIGKILL fires (fake kill)", async () => {
    if (!startTimeReadable) return;
    const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 50 && sleeper.pid === undefined; i++) await sleep(10);
      const pid = sleeper.pid!;
      const realStart = readProcessStartTime(pid);
      expect(realStart).not.toBeNull();

      const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
      await waitForPortRelease(21500, pid, {
        graceMs: 0,
        killWaitMs: 0,
        expectedProjectRoot: OURS,
        targetStartTime: realStart, // matches ⇒ provably the same process
        kill: (p, s) => kills.push({ pid: p, sig: s }), // fake — don't really kill here
        log: () => {},
      });
      // start-time matched the live read ⇒ escalation fires.
      expect(kills).toEqual([{ pid, sig: "SIGKILL" }]);
    } finally {
      try { sleeper.kill("SIGKILL"); } catch { /* gone */ }
    }
  });
});
