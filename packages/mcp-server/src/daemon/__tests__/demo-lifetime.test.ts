/**
 * #168 — demo daemon lifetime + money-shot replay, driven through the REAL
 * `createDaemon` factory (fakes-not-mocks: recording exitProcess, a real
 * listening socket + real ws clients).
 *
 *  - Idle grace: a `deeppairing demo` run registers NO wrapper and, once the
 *    CLI exits, holds NO WS client — so the plain 60s idle-shutdown would kill
 *    the daemon and the printed URL would refuse a late click. A demo session
 *    inside its 10-minute grace must keep the daemon alive; once the grace
 *    expires the normal idle shutdown proceeds.
 *  - Replay: the demo's hero `preflight_blocked` (t+5s) is a transient
 *    broadcast, not persisted state. A tab opened AFTER it fired must still
 *    receive it on connect (replayed) — otherwise the demo's entire point is
 *    missed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createDaemon, type CreateDaemonDeps, type Daemon } from "../create-daemon.js";
import { projectHashOf } from "../../project-root.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";

interface Harness {
  tmpDir: string;
  daemon: Daemon;
  exits: number[];
}

let harnesses: Harness[] = [];

function makeDaemon(overrides: Partial<CreateDaemonDeps> = {}): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-demo-lifetime-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  const exits: number[] = [];
  const daemon = createDaemon({
    projectRoot: tmpDir,
    authToken: "test-token",
    log: () => {},
    exitProcess: (code) => exits.push(code),
    releaseListenSocket: () => {},
    env: {},
    ...overrides,
  });
  const h: Harness = { tmpDir, daemon, exits };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try { h.daemon.dispose(); } catch { /* ignore */ }
    try { fs.rmSync(h.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  harnesses = [];
  setGlobalStoreForTests(null);
  vi.useRealTimers();
});

const PREFLIGHT = {
  type: "preflight_blocked",
  toolName: "present_findings",
  source: "session",
  match: {
    proposal: "Add a global mutable state singleton to hold config",
    description: "Config loader: global mutable ConfigStore singleton",
    reason: "we tried global state for config last project — broke testability",
    concept: "global mutable state for config",
    via: "concept",
  },
};

describe("#168 demo idle grace", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("keeps the daemon alive while a demo session is inside its 10-min grace, then shuts down after", () => {
    const { daemon, exits } = makeDaemon();
    const t0 = Date.parse("2026-07-19T12:00:00.000Z");
    vi.setSystemTime(t0);

    // Simulate the /api/demo/run route: a demo session, no wrapper, no client.
    daemon.createSession("demo_1");
    daemon.sessionMeta.set("demo_1", { title: "deepPairing demo", project: "demo", registeredAt: new Date(t0).toISOString() });

    // Idle (no active sessions, no clients) BUT inside the grace → no shutdown.
    daemon.checkAutoShutdown();
    vi.advanceTimersByTime(61_000);
    expect(exits).toEqual([]);

    // Advance past the 10-minute grace; the next idle check schedules the
    // normal 60s shutdown, which then fires.
    vi.setSystemTime(t0 + 11 * 60_000);
    daemon.checkAutoShutdown();
    vi.advanceTimersByTime(60_000);
    expect(exits).toEqual([0]);
  });

  it("an already-ARMED idle timer that fires after a demo session appears does NOT shut down (grace re-checked in the callback)", () => {
    // Reviewer repro: daemon idle → timer armed at t0 → a cadence tick at t0+30
    // leaves it armed → a `deeppairing demo` run (warm adopt, no cold spawn, no
    // WS client) creates an in-grace session at t0+45 → the timer fires at
    // t0+60. Pre-fix the callback only re-checked idleness → exitProcess(0)
    // despite the just-printed "URL stays live ~10 minutes". The callback now
    // also re-checks demoGraceActive().
    const { daemon, exits } = makeDaemon();
    const t0 = Date.parse("2026-07-19T12:00:00.000Z");
    vi.setSystemTime(t0);

    // Idle, no demo yet → arms the 60s shutdown timer.
    daemon.checkAutoShutdown();

    // Cadence tick at t0+30 — still idle, no grace → leaves the timer armed.
    vi.advanceTimersByTime(30_000);
    daemon.checkAutoShutdown();

    // t0+45: a demo session appears (created directly — NOT via checkAutoShutdown,
    // isolating the callback's own backstop rather than the route's eager disarm).
    vi.advanceTimersByTime(15_000);
    daemon.createSession("demo_race");
    daemon.sessionMeta.set("demo_race", { title: "deepPairing demo", project: "demo", registeredAt: new Date(Date.now()).toISOString() });

    // t0+60: the armed timer fires. It must NOT exit — the session is in grace.
    vi.advanceTimersByTime(15_000);
    expect(exits).toEqual([]);
  });

  it("PRE-FIX shape: WITHOUT the grace an idle demo daemon shuts down in 60s", () => {
    // A NON-demo idle session reproduces the old (ungraced) behavior — proving
    // the 60s shutdown is exactly what the grace suppresses for demo sessions.
    const { daemon, exits } = makeDaemon();
    const t0 = Date.parse("2026-07-19T12:00:00.000Z");
    vi.setSystemTime(t0);
    daemon.createSession("sess_real");
    daemon.sessionMeta.set("sess_real", { title: "real", project: "not-demo", registeredAt: new Date(t0).toISOString() });
    daemon.checkAutoShutdown();
    vi.advanceTimersByTime(60_000);
    expect(exits).toEqual([0]);
  });
});

describe("#168 money-shot replay", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let server: ReturnType<typeof serve>;
  let port = 0;
  let hash = "";

  beforeEach(async () => {
    const h = makeDaemon();
    tmpDir = h.tmpDir;
    daemon = h.daemon;
    hash = projectHashOf(tmpDir);
    server = serve({ fetch: daemon.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      const s = server as unknown as { address(): AddressInfo | null; once(ev: string, cb: () => void): void };
      if (s.address()) return resolve();
      s.once("listening", () => resolve());
    });
    port = ((server as unknown as { address(): AddressInfo }).address()).port;
    daemon.attachUpgradeHandler(server as unknown as Parameters<Daemon["attachUpgradeHandler"]>[0]);
  });

  afterEach(() => {
    try { server.close(); } catch { /* already closed */ }
  });

  /** Collect frames a session ws client receives in the first `windowMs`. */
  function collectFrames(sessionId: string, windowMs = 800): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const frames: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionId=${sessionId}&projectHash=${hash}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      ws.on("message", (data) => {
        try { frames.push(JSON.parse(String(data))); } catch { /* ignore */ }
      });
      ws.on("open", () => setTimeout(() => { ws.close(); resolve(frames); }, windowMs));
      ws.on("unexpected-response", (_r, res) => reject(new Error(`upgrade rejected ${res.statusCode}`)));
      ws.on("error", (err) => reject(err));
    });
  }

  it("replays the hero preflight_blocked to a client that connects AFTER it fired", async () => {
    const sessionId = "demo_late";
    daemon.createSession(sessionId);
    daemon.sessionMeta.set(sessionId, { title: "deepPairing demo", project: "demo", registeredAt: new Date().toISOString() });

    // The money shot fires BEFORE this client connects (late joiner).
    daemon.broadcast(sessionId, PREFLIGHT);

    const frames = await collectFrames(sessionId);
    const blocked = frames.find((f) => f.type === "preflight_blocked");
    expect(blocked).toBeTruthy();
    expect(blocked.replayed).toBe(true);
    expect(blocked.match.concept).toBe("global mutable state for config");
  });

  it("PRE-FIX shape: a NON-demo session does NOT replay a past preflight_blocked", async () => {
    const sessionId = "sess_real2";
    daemon.createSession(sessionId);
    daemon.sessionMeta.set(sessionId, { title: "real", project: "x", registeredAt: new Date().toISOString() });
    daemon.broadcast(sessionId, PREFLIGHT);

    const frames = await collectFrames(sessionId);
    expect(frames.find((f) => f.type === "preflight_blocked")).toBeUndefined();
    expect(frames.find((f) => f.type === "connected")).toBeTruthy();
  });

  it("does not double-fire: a client already connected gets the LIVE event, no extra replay", async () => {
    const sessionId = "demo_live";
    daemon.createSession(sessionId);
    daemon.sessionMeta.set(sessionId, { title: "deepPairing demo", project: "demo", registeredAt: new Date().toISOString() });

    const framesP = collectFrames(sessionId, 900);
    // Let the client finish connecting, THEN fire the money shot live.
    await new Promise((r) => setTimeout(r, 250));
    daemon.broadcast(sessionId, PREFLIGHT);

    const frames = await framesP;
    const blocks = frames.filter((f) => f.type === "preflight_blocked");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].replayed).toBeUndefined(); // it's the live broadcast, not a replay
  });
});
