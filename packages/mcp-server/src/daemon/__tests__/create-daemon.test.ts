/**
 * #157 — regression tests for the daemon COMPOSITION, driven through the real
 * `createDaemon` factory. Each test here exists because a mutation audit
 * deleted a piece of production wiring in the old unimportable daemon/index.ts
 * script and the full suite stayed green:
 *
 *   - the #151 live-decisions closure (routes.decisions.test.ts:81 tested a
 *     REPLICA of the closure; gutting the real one to `return []` shipped) —
 *     now the REAL closure inside create-daemon.ts serves /api/decisions;
 *   - `applyTopLevelGuards` (the ONLY 64KB body cap covering the ROOT-level
 *     routes — /api/evict, /api/demo/run, the internal routes) was deletable;
 *   - `guardWatcher(watcher, log)` (H1-2) and the `safeHeartbeatTick` wrapper
 *     (H1-3) — the two daemon-crash guards — were deletable;
 *   - the shouldAutoOpenBrowser / decidePing guard call sites were deletable.
 *
 * Fakes not mocks: fake deps are real objects (an EventEmitter watcher, a
 * recording exitProcess) satisfying the factory's dep interfaces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DecisionOption } from "@deeppairing/shared";
import { createDaemon, type CreateDaemonDeps, type Daemon } from "../create-daemon.js";
import { projectHashOf } from "../../project-root.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import { __resetMetricsCacheForTests } from "../../store/metrics-store.js";
import { ERROR_CODES } from "../../error-codes.js";

const OPTS: DecisionOption[] = [
  { id: "o1", title: "Redis", description: "d", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
  { id: "o2", title: "In-proc", description: "d", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
];

interface Harness {
  tmpDir: string;
  daemon: Daemon;
  logs: string[];
  exits: number[];
  releases: Array<{ closeWs?: boolean } | undefined>;
}

let harnesses: Harness[] = [];

function makeDaemon(overrides: Partial<CreateDaemonDeps> = {}): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-factory-test-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  const logs: string[] = [];
  const exits: number[] = [];
  const releases: Array<{ closeWs?: boolean } | undefined> = [];
  const daemon = createDaemon({
    projectRoot: tmpDir,
    authToken: "test-token",
    log: (msg) => logs.push(msg),
    // Real recorder fakes — the factory must NEVER reach the actual
    // process.exit (that seam being required is part of the design).
    exitProcess: (code) => exits.push(code),
    releaseListenSocket: (opts) => releases.push(opts),
    env: {},
    ...overrides,
  });
  const h: Harness = { tmpDir, daemon, logs, exits, releases };
  harnesses.push(h);
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  harnesses = [];
});

afterEach(() => {
  for (const h of harnesses) {
    for (const store of h.daemon.sessions.values()) {
      // Discard debounced writers so rmSync below can't race a late flush.
      store.dispose();
    }
    h.daemon.dispose();
    fs.rmSync(h.tmpDir, { recursive: true, force: true });
  }
  __resetMetricsCacheForTests();
  setGlobalStoreForTests(null);
  vi.useRealTimers();
});

describe("#151 — the REAL live-decisions closure (not a replica)", () => {
  it("GET /api/decisions includes an unflushed decision from a factory-registered session", async () => {
    const { tmpDir, daemon } = makeDaemon();
    // Freeze timers so the ~100ms debounced flush provably cannot land
    // between resolve and the request — the exact field window #151 closed.
    vi.useFakeTimers();
    try {
      const store = daemon.createSession("s_live");
      store.createArtifact({ id: "a1", type: "decision", title: "Which cache?", content: {} });
      store.recordDecisionRequest({ decisionId: "d_fresh", artifactId: "a1", context: "Which cache?", options: OPTS });
      store.resolveDecision("d_fresh", "o1", "lowest latency");
      // Deliberately NO flush — the on-disk decisions.json must not exist yet,
      // so ONLY the daemon's live-sources closure can surface this decision.
      expect(
        fs.existsSync(path.join(tmpDir, ".deeppairing", "sessions", "s_live", "decisions.json")),
      ).toBe(false);

      const res = await daemon.app.request("/api/decisions", {
        headers: { "X-Project-Hash": projectHashOf(tmpDir) },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.decisions).toHaveLength(1);
      expect(body.decisions[0].decisionId).toBe("d_fresh");
      expect(body.decisions[0].resolved).toBe(true);
      expect(body.decisions[0].chosenOptionTitle).toBe("Redis");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("applyTopLevelGuards — the 64KB cap actually covers ROOT-level routes", () => {
  it("rejects a >64KB body on /api/evict with 413 before the handler runs", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const hash = projectHashOf(tmpDir);
    // Control: the route is reachable and answers 403 (wrong confirm-pid) for
    // a small body — so the 413 below is the GUARD, not a routing artifact.
    // (X-Project-Hash + the SP1 bearer are needed because the public sub-app's
    // AA4/SP1 middleware also match root-registered routes mounted after it —
    // pre-existing behavior the factory preserves.)
    const small = await daemon.app.request("/api/evict", {
      method: "POST",
      headers: { "X-Project-Hash": hash, Authorization: "Bearer test-token" },
      body: "{}",
    });
    expect(small.status).toBe(403);
    expect((await small.json()).code).toBe(ERROR_CODES.evict_pid_mismatch);

    const big = "x".repeat(64 * 1024 + 16);
    const res = await daemon.app.request("/api/evict", {
      method: "POST",
      // Even with the CORRECT pid header + hash, the body cap must win first —
      // otherwise a deleted guard would let this "evict" fire exitProcess.
      headers: {
        "X-Project-Hash": hash,
        Authorization: "Bearer test-token",
        "X-DeepPairing-Confirm-Pid": String(process.pid),
      },
      body: big,
    });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe(ERROR_CODES.body_too_large);
  });

  it("rejects a >64KB body on /api/demo/run (unauthenticated root route)", async () => {
    const { daemon } = makeDaemon();
    const res = await daemon.app.request("/api/demo/run", {
      method: "POST",
      body: "y".repeat(64 * 1024 + 16),
    });
    expect(res.status).toBe(413);
    // And no demo session was minted — the guard fired before the handler.
    expect(Array.from(daemon.sessions.keys()).filter((id) => id.startsWith("demo_"))).toEqual([]);
  });
});

describe("H1-2 — the hooks watcher is wired through guardWatcher", () => {
  class FakeWatcher extends EventEmitter {
    closed = false;
    close(): void {
      this.closed = true;
    }
  }

  it("a watcher 'error' is swallowed (logged + watcher closed), not an unhandled throw", () => {
    let fake: FakeWatcher | undefined;
    const { daemon, logs } = makeDaemon({
      watch: () => {
        fake = new FakeWatcher();
        return fake;
      },
    });
    daemon.startHooksWatcher();
    expect(fake).toBeDefined();

    // Node invariant: emitting 'error' on an EventEmitter with NO listener
    // THROWS — which in the daemon becomes uncaughtException → exit(1). With
    // guardWatcher wired, the listener exists, so this must not throw…
    expect(() =>
      fake!.emit("error", Object.assign(new Error("inotify watch limit reached"), { code: "ENOSPC" })),
    ).not.toThrow();
    // …and the guard's degrade path ran: logged once + closed the watcher.
    expect(logs.some((l) => l.includes("[hook-watcher] watcher error"))).toBe(true);
    expect(fake!.closed).toBe(true);
  });
});

describe("H1-3 — the heartbeat runs through safeHeartbeatTick", () => {
  it("a failing periodic writeDaemonInfo is logged and does NOT propagate out of the tick", async () => {
    const { tmpDir, daemon, logs } = makeDaemon({ heartbeatIntervalMs: 15 });
    // Sabotage: plant a FILE at .deeppairing so writeDaemonInfo's
    // mkdirSync(dpDir, { recursive: true }) throws EEXIST on every tick —
    // a real fs failure, not a stubbed one.
    fs.writeFileSync(path.join(tmpDir, ".deeppairing"), "not a directory");

    daemon.startHeartbeat(0);
    await sleep(120); // several 15ms ticks

    // The message below is emitted ONLY by safeHeartbeatTick's catch. If the
    // wrapper is removed (tick calls writeDaemonInfo directly), the throw
    // escapes the setInterval callback as an uncaughtException — vitest flags
    // the unhandled error AND this assertion fails.
    expect(
      logs.some((l) => l.includes("[heartbeat] periodic writeDaemonInfo failed")),
    ).toBe(true);
    // The daemon would still be alive: nothing called the exit seam.
    expect(harnesses[0]!.exits).toEqual([]);
  });
});

describe("#152 / R4 — the auto-open and install-health-ping guard call sites", () => {
  it("DEEPPAIRING_NO_OPEN=1 suppresses the browser open; default env opens", () => {
    const opened: string[] = [];
    const openBrowser = async (url: string) => {
      opened.push(url);
    };
    const suppressed = makeDaemon({ env: { DEEPPAIRING_NO_OPEN: "1" }, openBrowser });
    suppressed.daemon.maybeAutoOpenBrowser(4001);
    expect(opened).toEqual([]);

    const open = makeDaemon({ env: {}, openBrowser });
    open.daemon.maybeAutoOpenBrowser(4002);
    expect(opened).toEqual(["http://localhost:4002"]);
  });

  it("without the explicit double opt-in, the install-health ping is skipped (and says so)", () => {
    const { daemon, logs } = makeDaemon({ env: {} });
    daemon.scheduleInstallHealthPing();
    expect(logs.some((l) => l.includes("Install-health ping: skipped"))).toBe(true);
  });

  it("with DEEPPAIRING_PING=1 + URL the ping is scheduled (not skipped)", () => {
    const { daemon, logs } = makeDaemon({
      env: { DEEPPAIRING_PING: "1", DEEPPAIRING_PING_URL: "http://127.0.0.1:9/ping" },
    });
    daemon.scheduleInstallHealthPing(); // 60s unref'd timer; dispose() clears it
    expect(logs.some((l) => l.includes("Install-health ping: skipped"))).toBe(false);
  });
});
