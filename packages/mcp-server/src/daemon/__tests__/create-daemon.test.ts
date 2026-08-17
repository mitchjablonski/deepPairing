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
import path from "node:path";
import type { DecisionOption } from "@deeppairing/shared";
import { createDaemon, type CreateDaemonDeps, type Daemon } from "../create-daemon.js";
import { projectHashOf } from "../../project-root.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { ERROR_CODES } from "../../error-codes.js";
import { PENDING_DRAFT_TYPES } from "../../mcp/tools/types.js";
// The web "waiting on you" set — imported here (a server-project test, so no web
// tsconfig rootDir boundary) to pin it EQUAL to the server's PENDING_DRAFT_TYPES.
import { REVIEWABLE_TYPES } from "../../../web/src/lib/pending.js";

const OPTS: DecisionOption[] = [
  { id: "o1", title: "Redis", description: "d", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
  { id: "o2", title: "In-proc", description: "d", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
];

interface Harness {
  tmpDir: string;
  fx: GlobalStoreFixture;
  daemon: Daemon;
  logs: string[];
  exits: number[];
  releases: Array<{ closeWs?: boolean } | undefined>;
}

let harnesses: Harness[] = [];

function makeDaemon(overrides: Partial<CreateDaemonDeps> = {}): Harness {
  const fx = withGlobalStore("dp-factory-test-");
  const tmpDir = fx.dir;
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
  const h: Harness = { tmpDir, fx, daemon, logs, exits, releases };
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
    h.fx.dispose();
  }
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

describe("#175 — daemon pendingCount counts a draft changeset (parity with lib/pending.ts)", () => {
  it("a draft changeset is reflected in /api/daemon-info pendingCount", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const store = daemon.createSession("s_cs");
    // A draft changeset genuinely awaits the human's review — the in-app
    // "waiting on you" count includes it, so the cross-project daemon badge must
    // too (pre-fix PENDING_REVIEWABLE omitted "changeset" → this returned 0).
    store.createArtifact({
      id: "cs1", type: "changeset", title: "Refactor auth",
      content: { files: [{ path: "auth/session.ts", changeType: "modified", hunks: [] }] },
    });
    const res = await daemon.app.request("/api/daemon-info", {
      headers: { "X-Project-Hash": projectHashOf(tmpDir) },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).pendingCount).toBe(1);
  });
});

// #190 — the two "waiting on you" sets (the daemon's PENDING_REVIEWABLE and the
// web PendingBanner's REVIEWABLE_TYPES) must stay EQUAL to the MCP server's
// PENDING_DRAFT_TYPES, or a new artifact type silently misses a nudge surface —
// exactly the #175 changeset omission, then reproduced for debrief/explainer.
// This is the class-ending guard: the parity assertion + the behavioral badge
// pin over EVERY PENDING_DRAFT_TYPE, so the NEXT type added to PENDING_DRAFT_TYPES
// fails here until it's added to both sets too.
//
// P3 — the guard now also runs in the REMOVE direction: `explainer` left all
// three sets (acknowledge-only — it owes the human a READ, not a verdict), so
// the explainer case below asserts a badge of ZERO. Removing a type from one set
// only would fail the equality above.
describe("#190 — 'waiting on you' set parity (daemon badge + web banner == PENDING_DRAFT_TYPES)", () => {
  it("the web REVIEWABLE_TYPES set equals the server PENDING_DRAFT_TYPES set exactly", () => {
    // `reasoning` is the only draft type deliberately NOT reviewable; it's absent
    // from PENDING_DRAFT_TYPES, so the two sets are a straight equality.
    expect(REVIEWABLE_TYPES.has("reasoning")).toBe(false);
    expect(new Set(PENDING_DRAFT_TYPES as readonly string[])).toEqual(new Set(REVIEWABLE_TYPES));
  });

  it("the daemon pendingCount counts a draft of EVERY PENDING_DRAFT_TYPE, and never a reasoning draft", () => {
    const { tmpDir, daemon } = makeDaemon();
    const store = daemon.createSession("s_parity");
    let i = 0;
    for (const type of PENDING_DRAFT_TYPES) {
      store.createArtifact({ id: `art_${i++}`, type, title: `${type} draft`, content: {} });
    }
    // A reasoning draft (agent narration) must NOT lift the badge.
    store.createArtifact({ id: "art_reasoning", type: "reasoning", title: "narration", content: {} });
    return daemon.app
      .request("/api/daemon-info", { headers: { "X-Project-Hash": projectHashOf(tmpDir) } })
      .then(async (res) => {
        expect(res.status).toBe(200);
        // Pre-fix (PENDING_REVIEWABLE missing debrief) this under-counted.
        expect((await res.json()).pendingCount).toBe(PENDING_DRAFT_TYPES.length);
      });
  });

  it("P3 — a draft EXPLAINER does NOT lift the badge (acknowledge-only, no verdict owed)", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const store = daemon.createSession("s_ex");
    store.createArtifact({
      id: "ex1", type: "explainer", title: "How auth works here",
      content: { title: "How auth works here", overview: "the walk", sections: [{ heading: "1. edge", body: "the cookie is read" }] },
    });
    const res = await daemon.app.request("/api/daemon-info", {
      headers: { "X-Project-Hash": projectHashOf(tmpDir) },
    });
    expect(res.status).toBe(200);
    // #190 A2 briefly counted this as 1; P3 reverts it — a walk-through the
    // human hasn't read yet is not work owed, and the cross-project "waiting on
    // you" badge must not claim otherwise. check_feedback still reports it under
    // its "TO READ" line.
    expect((await res.json()).pendingCount).toBe(0);
    // …while a genuine verdict surface in the SAME session still lifts it.
    store.createArtifact({ id: "db1", type: "debrief", title: "Debrief", content: {} });
    const res2 = await daemon.app.request("/api/daemon-info", {
      headers: { "X-Project-Hash": projectHashOf(tmpDir) },
    });
    expect((await res2.json()).pendingCount).toBe(1);
  });
});

// #192 (serving H1) — the daemon exposes an unanswered-question count (the
// INVERSE of pendingCount: a question the human asked that the agent still owes
// an answer). Uses the SAME shared tail-walk predicate the UI + first-call hint
// + check_feedback carryover use, so a question outliving its run stays visible.
describe("#192 — /api/daemon-info exposes unansweredQuestionCount", () => {
  it("counts an open human question and drops to 0 once answered", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const store = daemon.createSession("s_q");
    store.createArtifact({ id: "art_q", type: "changeset", title: "cs", content: { files: [] } });
    await store.addComment({
      id: "q1", artifactId: "art_q", content: "why cookies not JWT?",
      author: "human", intent: "question",
    });

    const res1 = await daemon.app.request("/api/daemon-info", { headers: { "X-Project-Hash": projectHashOf(tmpDir) } });
    expect((await res1.json()).unansweredQuestionCount).toBe(1);

    // Agent answers it (links answeredByCommentId via the reply).
    await store.addComment({
      id: "a1", artifactId: "art_q", content: "cookies — no client change.",
      author: "agent", parentCommentId: "q1",
    });
    // The store links the answer; if not, mark it resolved to mirror answer_question.
    await store.acknowledgeComments(["q1"]);

    const res2 = await daemon.app.request("/api/daemon-info", { headers: { "X-Project-Hash": projectHashOf(tmpDir) } });
    // The agent reply is the last substantive word in the thread → not waiting.
    expect((await res2.json()).unansweredQuestionCount).toBe(0);
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

describe("dispose() — the test-teardown seam actually clears every factory handle", () => {
  class FakeWatcher extends EventEmitter {
    closed = false;
    close(): void {
      this.closed = true;
    }
  }

  it("timers, the hooks watcher, and the wss are all released after dispose", async () => {
    // Mirrors the FileStore.dispose lesson (#151 flake): a dispose that leaves
    // a live timer/watcher/socket behind makes every suite that uses the
    // factory leak handles — and vitest only reports it as a hang much later.
    vi.useFakeTimers();
    let fake: FakeWatcher | undefined;
    const { daemon } = makeDaemon({
      watch: () => {
        fake = new FakeWatcher();
        return fake;
      },
      // Double opt-in so scheduleInstallHealthPing arms its 60s timer.
      env: { DEEPPAIRING_PING: "1", DEEPPAIRING_PING_URL: "http://127.0.0.1:9/ping" },
      heartbeatIntervalMs: 15,
    });
    daemon.startHeartbeat(0); // heartbeat interval
    daemon.startHooksWatcher(); // fs watcher
    daemon.scheduleInstallHealthPing(); // 60s ping timeout
    daemon.checkAutoShutdown(); // no sessions/clients → arms the 60s idle timer
    expect(vi.getTimerCount()).toBe(3);
    expect(fake).toBeDefined();

    let wssClosed = false;
    daemon.wss.on("close", () => {
      wssClosed = true;
    });

    daemon.dispose();

    // Every timer cleared — a no-op dispose leaves 3 live handles here.
    expect(vi.getTimerCount()).toBe(0);
    // The watcher was closed…
    expect(fake!.closed).toBe(true);
    // …and the WS server emitted 'close' (ws defers it a nextTick).
    await new Promise<void>((r) => process.nextTick(r));
    expect(wssClosed).toBe(true);
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
