/**
 * #136 — stale-daemon respawn on plugin update.
 *
 * A persistent per-project daemon is a long-lived Node process; updating the
 * plugin's files does NOT restart it. Pre-#136, a fresh MCP wrapper (running
 * NEW code) reattached to the OLD daemon still listening on the port and kept
 * serving pre-fix behavior indefinitely. These tests pin the version-gated
 * adoption policy that closes that hole.
 *
 * FAKES not mocks: the branching is exercised with injected fakes (a recording
 * `kill`, a fake `waitForRelease`, a fake identity probe) and — for the
 * identity re-confirm — a REAL fake Hono daemon serving /api/daemon-info. No
 * mocking library, no real SIGTERM, no real spawn.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  classifyDaemonVersion,
  describeDaemonVersionHealth,
  resolveStaleDaemon,
  type DaemonInfo,
} from "../daemon/lifecycle.js";
import { compareServerVersions, parseSemver } from "../version.js";

// --- Pure version helpers ---

describe("#136 — compareServerVersions / parseSemver", () => {
  it("parses N.N.N and ignores trailing metadata", () => {
    expect(parseSemver("0.1.5")).toEqual([0, 1, 5]);
    expect(parseSemver("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseSemver("nonsense")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });

  it("orders versions by major, then minor, then patch", () => {
    expect(compareServerVersions("0.1.4", "0.1.5")).toBeLessThan(0);
    expect(compareServerVersions("0.1.5", "0.1.5")).toBe(0);
    expect(compareServerVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareServerVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("returns NaN when either side is unparseable (never a silent 0)", () => {
    expect(Number.isNaN(compareServerVersions("garbage", "0.1.5"))).toBe(true);
    expect(Number.isNaN(compareServerVersions("0.1.5", ""))).toBe(true);
  });
});

describe("#136 — classifyDaemonVersion policy table", () => {
  it("same version → same", () => {
    expect(classifyDaemonVersion("0.1.5", "0.1.5")).toBe("same");
  });
  it("running older → older (restart)", () => {
    expect(classifyDaemonVersion("0.1.4", "0.1.5")).toBe("older");
  });
  it("running newer → newer (adopt, never downgrade)", () => {
    expect(classifyDaemonVersion("0.2.0", "0.1.5")).toBe("newer");
  });
  it("absent version → absent (pre-0.1.4 ⇒ stale)", () => {
    expect(classifyDaemonVersion(undefined, "0.1.5")).toBe("absent");
    expect(classifyDaemonVersion("", "0.1.5")).toBe("absent");
    expect(classifyDaemonVersion(null, "0.1.5")).toBe("absent");
  });
  it("unparseable version → unknown (fail loud, restart)", () => {
    expect(classifyDaemonVersion("dev", "0.1.5")).toBe("unknown");
  });
});

// --- resolveStaleDaemon branching (injected fakes) ---

function makeInfo(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    pid: 4242,
    port: 3900,
    startedAt: "2026-07-08T00:00:00.000Z",
    projectRoot: "/projects/mine",
    version: "0.1.5",
    ...overrides,
  };
}

/** A recording fake set: no real process is ever signalled. */
function fakes(identity: { pid: number; projectRoot: string; startedAt: string; version?: string } | null) {
  const kills: Array<{ pid: number; sig: NodeJS.Signals }> = [];
  const released: Array<{ port: number; pid: number }> = [];
  const logs: string[] = [];
  let probeCalls = 0;
  return {
    kills,
    released,
    logs,
    probeCalls: () => probeCalls,
    deps: {
      probeIdentity: async (_port: number) => {
        probeCalls++;
        return identity;
      },
      kill: (pid: number, sig: NodeJS.Signals) => { kills.push({ pid, sig }); },
      waitForRelease: async (port: number, pid: number) => { released.push({ port, pid }); },
      log: (m: string) => { logs.push(m); },
    },
  };
}

describe("#136 — resolveStaleDaemon adopt/restart policy", () => {
  const MINE = "0.1.5";
  const ROOT = "/projects/mine";

  it("OLDER running daemon → restarted (SIGTERM + waited for port release)", async () => {
    const info = makeInfo({ version: "0.1.4", pid: 111, port: 3901 });
    const f = fakes({ pid: 111, projectRoot: ROOT, startedAt: "x", version: "0.1.4" });
    const outcome = await resolveStaleDaemon(info, MINE, ROOT, f.deps);
    expect(outcome).toBe("restarted");
    expect(f.kills).toEqual([{ pid: 111, sig: "SIGTERM" }]);
    expect(f.released).toEqual([{ port: 3901, pid: 111 }]);
    expect(f.logs.join("\n")).toMatch(/restarting it/);
  });

  it("SAME version → adopted, NO respawn (fast path: no probe, no kill)", async () => {
    const info = makeInfo({ version: "0.1.5" });
    const f = fakes({ pid: info.pid, projectRoot: ROOT, startedAt: "x", version: "0.1.5" });
    const outcome = await resolveStaleDaemon(info, MINE, ROOT, f.deps);
    expect(outcome).toBe("adopt");
    expect(f.kills).toEqual([]);
    // Fast path must NOT even re-probe — it's the common every-tool-call path.
    expect(f.probeCalls()).toBe(0);
  });

  it("NEWER daemon → adopted + WARNING, NOT killed (never downgrade)", async () => {
    const info = makeInfo({ version: "0.2.0" });
    const f = fakes({ pid: info.pid, projectRoot: ROOT, startedAt: "x", version: "0.2.0" });
    const outcome = await resolveStaleDaemon(info, MINE, ROOT, f.deps);
    expect(outcome).toBe("adopt");
    expect(f.kills).toEqual([]);
    expect(f.logs.join("\n")).toMatch(/NEWER than this plugin/i);
  });

  it("ABSENT version (pre-0.1.4 daemon) → treated as stale → restarted", async () => {
    const info = makeInfo({ version: undefined, pid: 222, port: 3902 });
    const f = fakes({ pid: 222, projectRoot: ROOT, startedAt: "x", version: undefined });
    const outcome = await resolveStaleDaemon(info, MINE, ROOT, f.deps);
    expect(outcome).toBe("restarted");
    expect(f.kills).toEqual([{ pid: 222, sig: "SIGTERM" }]);
  });

  it("a daemon for a DIFFERENT projectRoot is NEVER signalled", async () => {
    // Discovery said stale + our pid, but the live re-probe reports a foreign
    // projectRoot (pid reuse / port handoff) — the projectRoot guard must veto.
    const info = makeInfo({ version: "0.1.4", pid: 333 });
    const f = fakes({ pid: 333, projectRoot: "/projects/SOMEONE_ELSE", startedAt: "x", version: "0.1.4" });
    const outcome = await resolveStaleDaemon(info, MINE, ROOT, f.deps);
    expect(outcome).toBe("adopt");
    expect(f.kills).toEqual([]);
    expect(f.logs.join("\n")).toMatch(/refusing to restart/i);
  });

  it("a recycled PID (identity pid drifted) is NEVER signalled", async () => {
    const info = makeInfo({ version: "0.1.4", pid: 444 });
    const f = fakes({ pid: 999, projectRoot: ROOT, startedAt: "x", version: "0.1.4" });
    const outcome = await resolveStaleDaemon(info, MINE, ROOT, f.deps);
    expect(outcome).toBe("adopt");
    expect(f.kills).toEqual([]);
  });

  it("probe error (identity undeterminable) → no kill, no hang, adopt", async () => {
    const info = makeInfo({ version: "0.1.4", pid: 555 });
    const f = fakes(null); // re-probe fails
    const outcome = await resolveStaleDaemon(info, MINE, ROOT, f.deps);
    expect(outcome).toBe("adopt");
    expect(f.kills).toEqual([]);
    expect(f.released).toEqual([]);
  });
});

// --- resolveStaleDaemon against a REAL fake daemon (real HTTP re-probe) ---

// port 0 — OS-assigned per fakeDaemon (was a hardcoded 24870); fakeDaemon
// records the bound port here for the test body's DaemonInfo.
let HTTP_PORT = 0;
let server: { close?: (cb?: () => void) => void } | null = null;

async function fakeDaemon(opts: { pid: number; projectRoot: string; version?: string }): Promise<typeof server> {
  const app = new Hono();
  app.get("/api/daemon-info", (c) =>
    c.json({
      pid: opts.pid,
      projectRoot: opts.projectRoot,
      startedAt: "2026-07-08T00:00:00.000Z",
      ...(opts.version !== undefined ? { version: opts.version } : {}),
    }),
  );
  let s: typeof server = null;
  HTTP_PORT = await new Promise<number>((resolve) => {
    s = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  return s;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      try { server!.close?.(() => resolve()); } catch { resolve(); }
    });
    server = null;
  }
});

describe("#136 — resolveStaleDaemon with the REAL identity probe (fake Hono daemon)", () => {
  const ROOT = "/projects/real";

  it("older daemon whose live daemon-info matches our root+pid → restarted", async () => {
    server = await fakeDaemon({ pid: 7777, projectRoot: ROOT, version: "0.1.4" });
    const info: DaemonInfo = { pid: 7777, port: HTTP_PORT, startedAt: "x", projectRoot: ROOT, version: "0.1.4" };
    const kills: number[] = [];
    const outcome = await resolveStaleDaemon(info, "0.1.5", ROOT, {
      // real probeIdentity (default) hits the fake daemon over HTTP
      kill: (pid) => kills.push(pid),
      waitForRelease: async () => {},
    });
    expect(outcome).toBe("restarted");
    expect(kills).toEqual([7777]);
  });

  it("older daemon whose live daemon-info reports a DIFFERENT project → NOT signalled", async () => {
    // The daemon on the port now serves another project (real HTTP says so).
    server = await fakeDaemon({ pid: 7777, projectRoot: "/projects/other", version: "0.1.4" });
    const info: DaemonInfo = { pid: 7777, port: HTTP_PORT, startedAt: "x", projectRoot: ROOT, version: "0.1.4" };
    const kills: number[] = [];
    const outcome = await resolveStaleDaemon(info, "0.1.5", ROOT, {
      kill: (pid) => kills.push(pid),
      waitForRelease: async () => {},
    });
    expect(outcome).toBe("adopt");
    expect(kills).toEqual([]);
  });

  it("daemon.json lagged old, but live /api/daemon-info reports current → adopt (no false-positive kill)", async () => {
    // The discovered DaemonInfo (from a stale daemon.json read) looked old, but
    // the authoritative HTTP re-probe says the daemon is actually current — a
    // same-second restart wrote the file before the process served the new
    // version. The daemon must NOT be killed.
    server = await fakeDaemon({ pid: 7777, projectRoot: ROOT, version: "0.1.5" });
    const info: DaemonInfo = { pid: 7777, port: HTTP_PORT, startedAt: "x", projectRoot: ROOT, version: "0.1.4" };
    const kills: number[] = [];
    const outcome = await resolveStaleDaemon(info, "0.1.5", ROOT, {
      kill: (pid) => kills.push(pid),
      waitForRelease: async () => {},
    });
    expect(outcome).toBe("adopt");
    expect(kills).toEqual([]);
  });

  it("daemon-info with NO version field (pre-#136) → stale → restarted", async () => {
    server = await fakeDaemon({ pid: 7777, projectRoot: ROOT /* no version */ });
    const info: DaemonInfo = { pid: 7777, port: HTTP_PORT, startedAt: "x", projectRoot: ROOT, version: undefined };
    const kills: number[] = [];
    const outcome = await resolveStaleDaemon(info, "0.1.5", ROOT, {
      kill: (pid) => kills.push(pid),
      waitForRelease: async () => {},
    });
    expect(outcome).toBe("restarted");
    expect(kills).toEqual([7777]);
  });
});

// --- doctor staleness verdict ---

describe("#136 — describeDaemonVersionHealth (doctor)", () => {
  it("reports stale when the running daemon is older than the plugin", () => {
    const h = describeDaemonVersionHealth("0.1.4", "0.1.5");
    expect(h.stale).toBe(true);
    expect(h.verdict).toBe("older");
    expect(h.message).toMatch(/keeps serving old code|invisible/i);
  });

  it("reports stale for an unversioned (pre-0.1.4) daemon", () => {
    const h = describeDaemonVersionHealth(undefined, "0.1.5");
    expect(h.stale).toBe(true);
    expect(h.verdict).toBe("absent");
  });

  it("NOT stale when versions match", () => {
    const h = describeDaemonVersionHealth("0.1.5", "0.1.5");
    expect(h.stale).toBe(false);
    expect(h.verdict).toBe("same");
  });

  it("NOT stale when the daemon is newer (must not tell the user to restart it)", () => {
    const h = describeDaemonVersionHealth("0.2.0", "0.1.5");
    expect(h.stale).toBe(false);
    expect(h.verdict).toBe("newer");
  });
});
