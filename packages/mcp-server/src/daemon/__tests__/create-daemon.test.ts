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
import { serve, type ServerType } from "@hono/node-server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DecisionOption } from "@deeppairing/shared";
import { createDaemon, type CreateDaemonDeps, type Daemon } from "../create-daemon.js";
import { FileStore } from "../../store/file-store.js";
import type { IStore } from "../../store/store-interface.js";
import { projectHashOf } from "../../project-root.js";
import { createStandaloneSessionId } from "../../standalone-session-id.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { ERROR_CODES } from "../../error-codes.js";
import { PENDING_DRAFT_TYPES } from "../../mcp/tools/types.js";
// The web "waiting on you" set — imported here (a server-project test, so no web
// tsconfig rootDir boundary) to pin it EQUAL to the server's PENDING_DRAFT_TYPES.
import { REVIEWABLE_TYPES } from "../../../web/src/lib/pending.js";
// #430 PR 1a — the web attention selector, pinned to the daemon badge below.
import { computeAttention } from "../../../web/src/lib/attention.js";

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

it("waits for the exact committed standalone choice and releases a disconnected HTTP waiter", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const store = daemon.createSession(sessionId);
  store.createArtifact({ id: "a1", type: "decision", title: "Which cache?", content: { decisionId: "d1" } });
  store.recordDecisionRequest({ decisionId: "d1", artifactId: "a1", context: "Which cache?", options: OPTS });
  const waiters = () => (store as unknown as { feedbackWaiters: Array<() => void> }).feedbackWaiters;

  let server!: ServerType;
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: daemon.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
  });
  const headers = {
    "X-Project-Hash": projectHashOf(tmpDir), "X-Session-Id": sessionId,
    "Content-Type": "application/json", Authorization: "Bearer test-token",
  };
  const read = (signal: AbortSignal, args: { decisionId: string; waitMs?: number } = { decisionId: "d1", waitMs: 10_000 }) =>
    fetch(`http://127.0.0.1:${port}/api/internal/sessions/${sessionId}/read-decision`, {
      method: "POST", signal, headers,
      body: JSON.stringify({ expectedProjectRoot: tmpDir, ...args }),
    });
  const disconnect = new AbortController();
  const continueWait = new AbortController();
  try {
    const abandoned = read(disconnect.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(waiters()).toHaveLength(1));
    disconnect.abort();
    expect(await abandoned).toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(waiters()).toHaveLength(0));

    const pending = read(continueWait.signal);
    // Attach a handler in case cleanup aborts this request before we await it.
    void pending.catch(() => {});
    await vi.waitFor(() => expect(waiters()).toHaveLength(1));
    const [originalWaiter] = waiters();
    store.addComment({ id: "note", artifactId: "a1", content: "A comment is not a pick.", author: "human" });
    await vi.waitFor(() => {
      expect(waiters()).toHaveLength(1);
      expect(waiters()[0]).not.toBe(originalWaiter);
    });
    const picked = await daemon.app.request("/api/decisions/d1", {
      method: "POST", headers, body: JSON.stringify({ optionId: "o2", reasoning: "Simpler to run" }),
    });
    expect(picked.status, await picked.text()).toBe(200);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ waitStatus: "resolved", selectedOptionId: "o2", reasoning: "Simpler to run" });
    expect(waiters()).toHaveLength(0);
    expect(store.getResolvedDecisions()).toHaveLength(1);
    expect(store.getUnacknowledgedComments().map((comment) => comment.id)).toEqual(["note"]);

    store.createArtifact({ id: "a2", type: "decision", title: "Which queue?", content: { decisionId: "d2" } });
    store.recordDecisionRequest({ decisionId: "d2", artifactId: "a2", context: "Which queue?", options: OPTS });
    const rejection = read(continueWait.signal, { decisionId: "d2", waitMs: 10_000 });
    void rejection.catch(() => {});
    await vi.waitFor(() => expect(waiters()).toHaveLength(1));
    const reason = "This service does not need a queue.";
    const rejected = await daemon.app.request("/api/artifacts/a2/status", {
      method: "POST", headers, body: JSON.stringify({ status: "rejected", feedback: reason }),
    });
    expect(rejected.status, await rejected.text()).toBe(200);
    const closedRead = await (await rejection).json();
    expect(closedRead).toMatchObject({ waitStatus: "closed", artifactStatus: "rejected" });
    expect(closedRead).not.toHaveProperty("selectedOptionId");
    expect(waiters()).toHaveLength(0);
    const fastPath = await read(continueWait.signal, { decisionId: "d2", waitMs: 10_000 });
    expect(await fastPath.json()).toEqual(closedRead);
    expect(waiters()).toHaveLength(0);
    const immediate = await read(continueWait.signal, { decisionId: "d2" });
    expect(await immediate.json()).not.toHaveProperty("waitStatus");
    expect(store.getUnacknowledgedStatusChanges().map((artifact) => artifact.id)).toContain("a2");
    expect(store.getUnacknowledgedComments().map((comment) => comment.content)).toContain(reason);

    // Parent remains draft until the second half of revision marks it superseded.
    store.createArtifact({ id: "a3", type: "decision", title: "Which backend?", content: { decisionId: "d3" } });
    store.recordDecisionRequest({ decisionId: "d3", artifactId: "a3", context: "Which backend?", options: OPTS });
    store.createArtifact({ id: "a4", type: "decision", title: "Which backend v2?", content: { decisionId: "d4" }, parentId: "a3", version: 2 });
    const revised = await read(continueWait.signal, { decisionId: "d3", waitMs: 10_000 });
    expect(await revised.json()).toMatchObject({ waitStatus: "closed", artifactStatus: "draft", artifactId: "a3" });
    expect(waiters()).toHaveLength(0);

    store.updateArtifactStatus("a1", "obsolete", "agent_obsolete");
    const resolved = await read(continueWait.signal);
    expect(await resolved.json()).toMatchObject({ waitStatus: "resolved", artifactStatus: "obsolete", selectedOptionId: "o2" });
    expect(store.getResolvedDecisions().map((decision) => decision.decisionId)).toEqual(["d1"]);
  } finally {
    disconnect.abort();
    continueWait.abort();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("drains an admitted default browser comment and refuses a late request only for that review", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const store = daemon.createSession(sessionId);
  const sibling = daemon.createSession(createStandaloneSessionId(tmpDir));
  const wrapper = daemon.createSession("session_wrapper");
  const headers = {
    "X-Project-Hash": projectHashOf(tmpDir), "Content-Type": "application/json", Authorization: "Bearer test-token",
  };
  const post = (route: string, body: Record<string, unknown>, sid?: string) =>
    daemon.app.request(`/api/${route}`, {
      method: "POST", headers: { ...headers, ...(sid ? { "X-Session-Id": sid } : {}) },
      body: JSON.stringify(body),
    });
  const request = { text: "Explain the change", intent: "explain" };
  const comment = { artifactId: "__session__", content: "Keep this feedback" };
  let entered = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const addComment = store.addComment.bind(store);
  const delayed = vi.spyOn(store as IStore, "addComment").mockImplementationOnce(async (params) => {
    entered = true;
    await blocked;
    return addComment(params);
  });
  const admitted = post("comments", comment);
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    const ending = daemon.standaloneCloseout.end(sessionId);
    const marker = path.join(tmpDir, ".deeppairing", "sessions", sessionId, "review-ended.json");
    try {
      const late = await post("requests", request, sessionId);
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({ code: "session_closing" });
      expect(fs.existsSync(marker)).toBe(false);
      expect((await post("requests", request, sibling.getSessionId())).status).toBe(200);
      expect((await post("requests", request, wrapper.getSessionId())).status).toBe(200);
    } finally {
      release();
      await ending;
    }
    expect((await admitted).status).toBe(200);
    expect(fs.existsSync(marker)).toBe(true);
    const disk = JSON.parse(fs.readFileSync(path.join(path.dirname(marker), "comments.json"), "utf8"));
    expect(disk).toEqual([expect.objectContaining({
      sessionId, content: comment.content, target: expect.objectContaining({ artifactId: comment.artifactId }),
    })]);
    expect(store.getRequests()).toEqual([]);
    const ended = await post("requests", request);
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({ code: "session_ended" });
    fs.writeFileSync(marker, "{");
    const invalid = await post("comments", comment);
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({ code: "session_marker_invalid" });
  } finally {
    release();
    await admitted;
    delayed.mockRestore();
  }
});

it("End drains an admitted headerless rename and rejects six late browser writes to the exact review", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const store = daemon.createSession(sessionId);
  const sibling = daemon.createSession(createStandaloneSessionId(tmpDir));
  const wrapper = daemon.createSession("session_wrapper");
  for (const session of [store, sibling, wrapper]) {
    session.createArtifact({ id: "late", type: "page", title: "Original", content: { title: "Original", html: "<p>Review me</p>" } });
  }
  store.createArtifact({ id: "admitted", type: "page", title: "Old title", content: { title: "Old title", html: "<p>Review me</p>" } });
  store.createArtifact({ id: "decision", type: "decision", title: "Choose a cache", content: { decisionId: "d1" } });
  store.recordDecisionRequest({ decisionId: "d1", artifactId: "decision", context: "Choose a cache", options: OPTS });
  store.addComment({ id: "resolve", artifactId: "late", content: "Still open", author: "human", intent: "question" });
  store.addComment({ id: "reopen", artifactId: "late", content: "Already resolved", author: "human", intent: "question" });
  store.markCommentHumanResolved("reopen");
  const existingResolution = store.getComment("reopen")!.humanResolvedAt;
  store.addComment({
    id: "suggestion", artifactId: "late", content: "Please clarify", author: "human", intent: "suggestion",
    suggestion: { originalText: "old", replacementText: "new", lineStart: 1, lineEnd: 1, state: "countered", counter: { reason: "Another approach" } },
  });

  const headers = { Authorization: "Bearer test-token", "X-Project-Hash": projectHashOf(tmpDir), "Content-Type": "application/json" };
  const post = (route: string, body: Record<string, unknown> = {}, headerSession?: string) =>
    daemon.app.request(`/api/${route}`, {
      method: "POST", headers: { ...headers, ...(headerSession ? { "X-Session-Id": headerSession } : {}) }, body: JSON.stringify(body),
    });
  const assertRefusals = async (code: string) => {
    const writes = [
      ["comments/resolve/mark-resolved", {}],
      ["comments/reopen/mark-unresolved", {}],
      ["comments/suggestion/suggestion", { action: "insist" }],
      ["artifacts/late/rename", { title: "Denied rename" }],
      ["decisions/d1", { optionId: "o1" }],
      ["decisions/d1/close-out", { sessionId, note: "Denied close-out" }, sibling.getSessionId()],
    ] as const;
    for (const [route, body, headerSession] of writes) {
      const response = await post(route, body, headerSession);
      expect(response.status, route).toBe(409);
      expect(await response.json(), route).toMatchObject({ code });
    }
  };

  let entered!: () => void;
  let release!: () => void;
  const enteredRename = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const rename = store.renameArtifact.bind(store);
  const delayed = vi.spyOn(store as IStore, "renameArtifact").mockImplementationOnce(async (id, title) => {
    entered();
    await blocked;
    return rename(id, title);
  });
  const admitted = post("artifacts/admitted/rename", { title: "Saved before End" });
  const marker = path.join(tmpDir, ".deeppairing", "sessions", sessionId, "review-ended.json");
  try {
    await Promise.race([enteredRename, admitted.then(() => { throw new Error("Rename did not reach the hold."); })]);
    const ending = daemon.standaloneCloseout.end(sessionId);
    try {
      await assertRefusals("session_closing");
      expect(fs.existsSync(marker)).toBe(false);
      expect((await post("artifacts/late/rename", { title: "Sibling title" }, sibling.getSessionId())).status).toBe(200);
      expect((await post("artifacts/late/rename", { title: "Wrapper title" }, wrapper.getSessionId())).status).toBe(200);
    } finally {
      release();
      await ending;
    }
    expect((await admitted).status).toBe(200);
    expect(fs.existsSync(marker)).toBe(true);
    await assertRefusals("session_ended");
    expect(store.getComment("resolve")?.humanResolvedAt).toBeUndefined();
    expect(store.getComment("reopen")?.humanResolvedAt).toBe(existingResolution);
    expect(store.getComment("suggestion")?.suggestion?.state).toBe("countered");
    expect(store.getDecisionResponse("d1")).toBeFalsy();
    expect(store.getCommentsForArtifact("decision")).toEqual([]);
    const rows = JSON.parse(fs.readFileSync(path.join(path.dirname(marker), "artifacts.json"), "utf8"));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "admitted", title: "Saved before End" }),
      expect.objectContaining({ id: "late", title: "Original" }),
      expect.objectContaining({ id: "decision", status: "draft" }),
    ]));
  } finally {
    release();
    await admitted;
    delayed.mockRestore();
  }
});

it("rejects a body-targeted cold ended close-out before constructing a transient writer", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sibling = daemon.createSession(createStandaloneSessionId(tmpDir));
  const sessionId = createStandaloneSessionId(tmpDir);
  const ended = daemon.createSession(sessionId);
  for (const store of [sibling, ended]) {
    store.createArtifact({ id: "decision", type: "decision", title: "Choose a cache", content: { decisionId: "d1" } });
    store.recordDecisionRequest({ decisionId: "d1", artifactId: "decision", context: "Choose a cache", options: OPTS });
  }
  await daemon.standaloneCloseout.end(sessionId);
  ended.dispose();
  daemon.sessions.delete(sessionId);
  const sessionDir = path.join(tmpDir, ".deeppairing", "sessions", sessionId);
  const artifactsPath = path.join(sessionDir, "artifacts.json");
  const before = fs.readFileSync(artifactsPath, "utf8");
  const mkdir = vi.spyOn(fs, "mkdirSync");
  try {
    const response = await daemon.app.request("/api/decisions/d1/close-out", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "X-Project-Hash": projectHashOf(tmpDir), "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, note: "This session is already ended" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "session_ended" });
    expect(mkdir.mock.calls.some(([dir]) => String(dir) === sessionDir)).toBe(false);
    expect(daemon.sessions.has(sessionId)).toBe(false);
    expect(fs.readFileSync(artifactsPath, "utf8")).toBe(before);
    expect(sibling.getArtifacts()[0]?.status).toBe("draft");
  } finally {
    mkdir.mockRestore();
  }
});

it("reads a cold ended review by path without writing session or project data", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const siblingId = createStandaloneSessionId(tmpDir);
  const history = daemon.createSession(sessionId);
  history.createArtifact({ id: "decision", type: "decision", title: "Choose a cache", content: { decisionId: "d1" } });
  history.recordDecisionRequest({ decisionId: "d1", artifactId: "decision", context: "Choose a cache", options: OPTS });
  history.resolveDecision("d1", "o2", "Keep the system simple");
  history.addComment({ id: "pending", artifactId: "decision", content: "Check the TTL", author: "human" });
  await daemon.standaloneCloseout.end(sessionId);
  const expected = JSON.parse(JSON.stringify(history.getFullState())) as ReturnType<FileStore["getFullState"]>;
  history.dispose();
  daemon.sessions.delete(sessionId);
  const sibling = daemon.createSession(siblingId);
  sibling.createArtifact({ id: "sibling", type: "research", title: "Sibling", content: {} });
  sibling.forceFlush();

  const base = path.join(tmpDir, ".deeppairing");
  const sessionDir = path.join(base, "sessions", sessionId);
  const markerPath = path.join(sessionDir, "review-ended.json");
  const optionalPath = path.join(sessionDir, "render-failures.json");
  const queuePath = path.join(base, "ledger-mirror-pending.json");
  fs.writeFileSync(optionalPath, "{ broken optional lane");
  fs.writeFileSync(queuePath, "[]\n");
  const namesBefore = fs.readdirSync(sessionDir).sort();
  const markerBefore = fs.readFileSync(markerPath, "utf8");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const mkdir = vi.spyOn(fs, "mkdirSync");
  const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const headers = { "X-Project-Hash": projectHashOf(tmpDir), "X-Session-Id": siblingId };
    const replay = await daemon.app.request(`/api/sessions/${sessionId}`, { headers });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);
    expect(mkdir.mock.calls).toHaveLength(0);
    expect(daemon.sessions.has(sessionId)).toBe(false);
    expect(fs.readdirSync(sessionDir).sort()).toEqual(namesBefore);
    expect(fs.readFileSync(markerPath, "utf8")).toBe(markerBefore);
    expect(fs.readFileSync(optionalPath, "utf8")).toBe("{ broken optional lane");
    expect(fs.readFileSync(queuePath, "utf8")).toBe("[]\n");

    const live = await daemon.app.request("/api/state", { headers });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ sessionId: siblingId, artifacts: [{ id: "sibling" }] });
  } finally {
    warnings.mockRestore();
    mkdir.mockRestore();
    vi.useRealTimers();
  }
});

it("End lets a held decision resolution settle before an admitted close-out inspects it", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const store = daemon.createSession(sessionId);
  store.createArtifact({ id: "decision", type: "decision", title: "Choose a cache", content: { decisionId: "d1" } });
  store.recordDecisionRequest({ decisionId: "d1", artifactId: "decision", context: "Choose a cache", options: OPTS });
  store.forceFlush();

  const headers = {
    Authorization: "Bearer test-token", "X-Project-Hash": projectHashOf(tmpDir),
    "X-Session-Id": sessionId, "Content-Type": "application/json",
  };
  const cancel = new AbortController();
  const post = (route: string, body: Record<string, unknown>) =>
    daemon.app.request(`/api/${route}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: cancel.signal,
    });
  const read = () => post(`internal/sessions/${sessionId}/read-decision`, {
    expectedProjectRoot: tmpDir, decisionId: "d1", waitMs: 10_000,
  });
  const wait = vi.spyOn(store, "waitForFeedback");
  const admission = vi.spyOn(daemon.standaloneCloseout, "admitWrite");
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const flushEntered = new Promise<void>((resolve) => { entered = resolve; });
  const flush = store.forceFlush.bind(store);
  const delayed = vi.spyOn(store as IStore, "forceFlush").mockImplementationOnce(async () => {
    entered();
    await held;
    flush();
  });
  const pendingRead = read();
  let resolving: Promise<Response> | undefined;
  let closingOut: Promise<Response> | undefined;
  let ending: ReturnType<typeof daemon.standaloneCloseout.end> | undefined;
  try {
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));
    resolving = post("decisions/d1", { optionId: "o2", reasoning: "Simpler to run" });
    await Promise.race([flushEntered, resolving.then(() => { throw new Error("Resolve did not reach the held flush."); })]);

    let closeOutSettled = false;
    closingOut = post("decisions/d1/close-out", { note: "Should not retire the decision" }).finally(() => {
      closeOutSettled = true;
    });
    await vi.waitFor(() => expect(admission.mock.results.filter(({ value }) => typeof value === "function")).toHaveLength(2));
    // Let the admitted request reach the decision lock before starting End.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeOutSettled).toBe(false);
    ending = daemon.standaloneCloseout.end(sessionId);
    expect(daemon.standaloneCloseout.state(sessionId)).toEqual({ state: "closing" });
    release();

    const [resolved, refused, observed] = await Promise.all([resolving, closingOut, pendingRead, ending]);
    expect(resolved.status).toBe(200);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "decision_already_resolved" });
    const expected = { waitStatus: "resolved", selectedOptionId: "o2", reasoning: "Simpler to run", artifactStatus: "approved" };
    expect(await observed.json()).toMatchObject(expected);
    expect(await (await read()).json()).toMatchObject(expected);
    expect(store.getCommentsForArtifact("decision")).toEqual([]);
  } finally {
    release();
    cancel.abort();
    await Promise.allSettled([pendingRead, resolving, closingOut, ending]);
    delayed.mockRestore();
    wait.mockRestore();
    admission.mockRestore();
  }
});

it("internal register never warms or creates a standalone review", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const missingId = createStandaloneSessionId(tmpDir);
  const coldOpenId = createStandaloneSessionId(tmpDir);
  const store = daemon.createSession(sessionId);
  const marker = await daemon.standaloneCloseout.end(sessionId);
  store.dispose();
  daemon.sessions.delete(sessionId);
  const sessionsDir = path.join(tmpDir, ".deeppairing", "sessions");
  const coldOpenDir = path.join(sessionsDir, coldOpenId);
  fs.mkdirSync(coldOpenDir);
  const dir = path.join(sessionsDir, sessionId);
  const files = () => fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]);
  const before = files();
  const register = (id: string) => daemon.app.request(`/api/internal/sessions/${id}/register`, {
    method: "POST", headers: {
      Authorization: "Bearer test-token", "X-Project-Hash": projectHashOf(tmpDir), "Content-Type": "application/json",
    },
    body: JSON.stringify({ expectedProjectRoot: tmpDir }),
  });

  const ended = await register(sessionId);
  expect(ended.status).toBe(409);
  expect(await ended.json()).toMatchObject({ code: "session_ended" });
  expect(daemon.sessions.has(sessionId)).toBe(false);
  expect(files()).toEqual(before);
  expect(JSON.parse(fs.readFileSync(path.join(dir, "review-ended.json"), "utf8"))).toEqual(marker);

  const missing = await register(missingId);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ code: "session_not_registered" });
  expect(daemon.sessions.has(missingId)).toBe(false);
  expect(fs.existsSync(path.join(sessionsDir, missingId))).toBe(false);

  const open = await register(coldOpenId);
  expect(open.status).toBe(409);
  expect(await open.json()).toMatchObject({ code: "session_not_registered" });
  expect(daemon.sessions.has(coldOpenId)).toBe(false);
  expect(fs.readdirSync(coldOpenDir)).toEqual([]);

  const wrapper = await register("session_wrapper");
  expect(wrapper.status).toBe(200);
  expect(daemon.sessions.has("session_wrapper")).toBe(true);
});

it("internal comment writers refuse a closing and ended review while sibling and wrapper writes succeed", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const siblingId = createStandaloneSessionId(tmpDir);
  const wrapperId = "session_wrapper";
  const store = daemon.createSession(sessionId);
  const sibling = daemon.createSession(siblingId);
  const wrapper = daemon.createSession(wrapperId);
  const suggestion = {
    originalText: "before", replacementText: "after", lineStart: 1, lineEnd: 1, state: "pending" as const,
  };
  for (const target of [store, sibling, wrapper]) {
    target.createArtifact({ id: "page", type: "page", title: "Page", content: { title: "Page", html: "<h1>Test</h1>" } });
    target.addComment({ id: "question", artifactId: "page", content: "What about this?", author: "human", intent: "question" });
    target.addComment({
      id: "suggestion", artifactId: "page", content: "Try this", author: "human", intent: "suggestion", suggestion,
    });
    target.forceFlush();
  }
  const writes: Array<[string, Record<string, unknown>]> = [
    ["comments", { id: "answer", artifactId: "page", content: "Here is the answer", author: "agent", parentCommentId: "question" }],
    ["comments/question/answered", { answerCommentId: "answer" }],
    ["comments/suggestion/suggestion", { state: "countered", counter: { reason: "Use a smaller change" } }],
  ];
  const post = (id: string, route: string, body: Record<string, unknown>) =>
    daemon.app.request(`/api/internal/sessions/${id}/${route}`, {
      method: "POST", headers: {
        Authorization: "Bearer test-token", "X-Project-Hash": projectHashOf(tmpDir), "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const markerDir = path.join(tmpDir, ".deeppairing", "sessions", sessionId);
  const commentsFile = path.join(markerDir, "comments.json");
  const before = fs.readFileSync(commentsFile, "utf8");
  const release = daemon.standaloneCloseout.admitWrite(sessionId);
  expect(release).toBeTypeOf("function");
  const ending = daemon.standaloneCloseout.end(sessionId);
  try {
    for (const [route, body] of writes) {
      const denied = await post(sessionId, route, body);
      expect(denied.status, route).toBe(409);
      expect(await denied.json(), route).toMatchObject({ code: "session_closing" });
      expect((await post(siblingId, route, body)).status, route).toBe(200);
      expect((await post(wrapperId, route, body)).status, route).toBe(200);
    }
    const registering = await post(sessionId, "register", { expectedProjectRoot: tmpDir });
    expect(registering.status).toBe(409);
    expect(await registering.json()).toMatchObject({ code: "session_closing" });
    expect(fs.existsSync(path.join(markerDir, "review-ended.json"))).toBe(false);
    expect(fs.readFileSync(commentsFile, "utf8")).toBe(before);
  } finally {
    release?.();
    await ending;
  }
  for (const [route, body] of writes) {
    const denied = await post(sessionId, route, body);
    expect(denied.status, route).toBe(409);
    expect(await denied.json(), route).toMatchObject({ code: "session_ended" });
  }
  expect(fs.readFileSync(commentsFile, "utf8")).toBe(before);
  expect(store.getComment("answer")).toBeUndefined();
  expect(store.getComment("question")?.answeredByCommentId).toBeFalsy();
  expect(store.getComment("suggestion")?.suggestion?.state).toBe("pending");
  for (const target of [sibling, wrapper]) {
    expect(target.getComment("answer")?.parentCommentId).toBe("question");
    expect(target.getComment("question")?.answeredByCommentId).toBe("answer");
    expect(target.getComment("suggestion")?.suggestion?.state).toBe("countered");
  }
});

it("End waits for an admitted internal decision resolve and refuses later writes only in that review", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const siblingId = createStandaloneSessionId(tmpDir);
  const store = daemon.createSession(sessionId);
  const sibling = daemon.createSession(siblingId);
  const resolvedAt = "2026-01-02T00:00:00.000Z";
  const decision = (id: string) => ({ decisionId: id, artifactId: `art_${id}`, context: "Choose a cache", options: OPTS });
  for (const target of [store, sibling]) {
    for (const id of ["initial", "pending", "new"]) {
      const entry = decision(id);
      target.createArtifact({ id: entry.artifactId, type: "decision", title: entry.context, content: { decisionId: id } });
      if (id !== "new") target.recordDecisionRequest(entry);
    }
    target.addComment({ id: "open", artifactId: "art_pending", content: "Needs an answer", author: "human" });
    target.addComment({ id: "resolved", artifactId: "art_pending", content: "Already done", author: "human" });
    target.markCommentHumanResolved("resolved", resolvedAt);
    target.acknowledgeComments(["resolved"]);
    target.forceFlush();
  }

  const post = (sid: string, route: string, body: Record<string, unknown>) =>
    daemon.app.request(`/api/internal/sessions/${sid}/${route}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token", "X-Project-Hash": projectHashOf(tmpDir),
        "X-Session-Id": sid, "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const writes: Array<[string, Record<string, unknown>]> = [
    ["comments/open/mark-resolved", {}],
    ["comments/resolved/mark-resolved", { resolvedAt: null }],
    ["decisions", decision("new")],
    ["decisions/pending/resolve", { optionId: "o1" }],
  ];
  const dir = path.join(tmpDir, ".deeppairing", "sessions", sessionId);
  const marker = path.join(dir, "review-ended.json");
  const records = () => ["artifacts.json", "decisions.json", "comments.json"].map((file) =>
    fs.readFileSync(path.join(dir, file), "utf8"));
  const commentsBefore = fs.readFileSync(path.join(dir, "comments.json"), "utf8");
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const flushEntered = new Promise<void>((resolve) => { entered = resolve; });
  const flush = store.forceFlush.bind(store);
  const delayed = vi.spyOn(store as IStore, "forceFlush").mockImplementationOnce(async () => {
    entered();
    await held;
    flush();
  });
  const resolving = post(sessionId, "decisions/initial/resolve", { optionId: "o2" });
  let ending: ReturnType<typeof daemon.standaloneCloseout.end> | undefined;
  try {
    await Promise.race([flushEntered, resolving.then(() => { throw new Error("Resolve did not reach the held flush."); })]);
    ending = daemon.standaloneCloseout.end(sessionId);
    for (const [route, body] of writes) {
      const denied = await post(sessionId, route, body);
      expect(denied.status, route).toBe(409);
      expect(await denied.json(), route).toMatchObject({ code: "session_closing" });
      expect((await post(siblingId, route, body)).status, route).toBe(200);
    }
    expect(fs.existsSync(marker)).toBe(false);
    // The admitted resolve's scheduled flush can run while the route is held.
    // Only the refused writes must leave their records untouched.
    expect(fs.readFileSync(path.join(dir, "comments.json"), "utf8")).toBe(commentsBefore);
    expect(store.getDecision("new")).toBeUndefined();
    expect(store.getDecision("pending")?.response).toBeUndefined();

    release();
    const [resolved, ended] = await Promise.all([resolving, ending]);
    expect(resolved.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual(ended);
    const committed = records();
    expect(JSON.parse(committed[1]!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ decisionId: "initial", response: expect.objectContaining({ optionId: "o2" }) }),
    ]));
    for (const [route, body] of writes) {
      const denied = await post(sessionId, route, body);
      expect(denied.status, route).toBe(409);
      expect(await denied.json(), route).toMatchObject({ code: "session_ended" });
    }
    expect(records()).toEqual(committed);
    expect(store.getDecision("new")).toBeUndefined();
    expect(store.getDecision("pending")?.response).toBeUndefined();
    expect(store.getComment("open")?.humanResolvedAt).toBeUndefined();
    expect(store.getComment("resolved")).toMatchObject({ humanResolvedAt: resolvedAt, acknowledged: true });
    expect(sibling.getDecision("new")?.artifactId).toBe("art_new");
    expect(sibling.getDecision("pending")?.response?.optionId).toBe("o1");
    expect(sibling.getComment("open")?.humanResolvedAt).toBeTruthy();
    expect(sibling.getComment("resolved")).toMatchObject({ humanResolvedAt: null, acknowledged: false });
  } finally {
    release();
    await Promise.allSettled([resolving, ending]);
    delayed.mockRestore();
  }
});

it("a failed admitted internal decision flush releases End after rolling the choice back", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const store = daemon.createSession(sessionId);
  store.createArtifact({ id: "decision", type: "decision", title: "Choose a cache", content: { decisionId: "d1" } });
  store.recordDecisionRequest({ decisionId: "d1", artifactId: "decision", context: "Choose a cache", options: OPTS });
  store.forceFlush();
  const dir = path.join(tmpDir, ".deeppairing", "sessions", sessionId);
  const decisionFile = path.join(dir, "decisions.json");
  const before = fs.readFileSync(decisionFile, "utf8");
  const flush = vi.spyOn(store, "forceFlush").mockImplementationOnce(() => { throw new Error("Cannot flush the choice"); });
  try {
    const failed = await daemon.app.request(`/api/internal/sessions/${sessionId}/decisions/d1/resolve`, {
      method: "POST", headers: {
        Authorization: "Bearer test-token", "X-Project-Hash": projectHashOf(tmpDir), "Content-Type": "application/json",
      },
      body: JSON.stringify({ optionId: "o2" }),
    });
    expect(failed.status).toBe(500);
    expect(store.getDecision("d1")?.response).toBeUndefined();
    expect(store.getArtifacts().find((a) => a.id === "decision")?.status).toBe("draft");
    const marker = await daemon.standaloneCloseout.end(sessionId);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "review-ended.json"), "utf8"))).toEqual(marker);
    expect(fs.readFileSync(decisionFile, "utf8")).toBe(before);
  } finally {
    flush.mockRestore();
  }
});

const RULE_OUT_HTML =
  "<table><tr><th>Strategy</th><th>Staleness</th></tr><tr><td>TTL expiry</td><td>Up to 60s</td></tr></table>";
const RULE_OUT_ANCHOR = {
  kind: "cell" as const,
  locator: "table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)",
  quote: "Up to 60s",
  table: { row: "TTL expiry", col: "Staleness" },
  version: 1,
};
const CHANGESET_FILES = [
  { path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 26 }] }] },
];

function seedReviewWriters(store: FileStore): void {
  store.createArtifact({ id: "held", type: "page", title: "Held", content: { title: "Held", html: "<p>Approve me</p>" } });
  store.createArtifact({ id: "late", type: "page", title: "Late", content: { title: "Late", html: RULE_OUT_HTML } });
  store.createArtifact({ id: "cs", type: "changeset", title: "Move TTL refresh", content: { files: CHANGESET_FILES } } as any);
  store.createArtifact({
    id: "decision", type: "decision", title: "Choose a cache",
    content: { decisionId: "d1", context: "Choose a cache", options: OPTS },
  });
  store.recordDecisionRequest({ decisionId: "d1", artifactId: "decision", context: "Choose a cache", options: OPTS });
  expect(store.resolveDecisionAtomic("d1", "o1")).toMatchObject({ kind: "resolved" });
  store.forceFlush();
}

function reviewWriterHarness(tmpDir: string, daemon: Daemon) {
  const headers = { Authorization: "Bearer test-token", "X-Project-Hash": projectHashOf(tmpDir), "Content-Type": "application/json" };
  const send = (method: string, route: string, body?: Record<string, unknown>, headerSession?: string) =>
    daemon.app.request(`/api/${route}`, {
      method,
      headers: { ...headers, ...(headerSession ? { "X-Session-Id": headerSession } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  // `headerSession` selects the store for header-scoped writes (undefined =
  // the headerless default); `otherHeader` rides on the path-scoped writes so
  // the path, not the header, must decide which review is admitted.
  const writes = (pathSession: string, headerSession: string | undefined, otherHeader: string) => [
    ["POST", "artifacts/late/rule-out", { htmlAnchor: RULE_OUT_ANCHOR, reason: "Stale sessions log people out" }, headerSession],
    ["POST", "decisions/d1/options/o2/never-suggest", { reason: "Too cold" }, headerSession],
    ["POST", "artifacts/cs/changeset-review", { filePath: "auth/middleware.ts", state: "reviewed" }, headerSession],
    ["POST", "render-failures", { artifactId: "late", visualId: "v1", error: "Parse error" }, headerSession],
    // Last: a rejected page takes no further rule-out.
    ["POST", "artifacts/late/status", { status: "rejected", feedback: "Not this" }, headerSession],
    ["POST", `sessions/${pathSession}/annotations`, { targetEventId: "evt_1", note: "Late note" }, otherHeader],
    ["DELETE", `sessions/${pathSession}/annotations/ann_existing`, undefined, otherHeader],
  ] as const;
  return { send, writes };
}

function seedAnnotation(tmpDir: string, sessionId: string): string {
  const file = path.join(tmpDir, ".deeppairing", "sessions", sessionId, "annotations.json");
  fs.writeFileSync(file, JSON.stringify([{ id: "ann_existing", sessionId, targetEventId: "evt_0", note: "Keep me", createdAt: new Date().toISOString() }]));
  return file;
}

it("End drains an admitted headerless verdict and refuses seven late browser writes to the exact review (#711)", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const store = daemon.createSession(sessionId);
  const sibling = daemon.createSession(createStandaloneSessionId(tmpDir));
  const wrapper = daemon.createSession("session_wrapper");
  for (const s of [store, sibling, wrapper]) seedReviewWriters(s as FileStore);
  const annotations = seedAnnotation(tmpDir, sessionId);
  seedAnnotation(tmpDir, sibling.getSessionId());
  seedAnnotation(tmpDir, wrapper.getSessionId());
  const annotationsBefore = fs.readFileSync(annotations, "utf8");
  const { send, writes } = reviewWriterHarness(tmpDir, daemon);
  const assertRefusals = async (code: string) => {
    // Headerless default store; annotations carry the SIBLING in the header.
    for (const [method, route, body, header] of writes(sessionId, undefined, sibling.getSessionId())) {
      const response = await send(method, route, body, header);
      expect(response.status, route).toBe(409);
      expect(await response.json(), route).toMatchObject({ code });
    }
  };
  const assertAccepted = async (pathSession: string, headerSession: string) => {
    for (const [method, route, body, header] of writes(pathSession, pathSession, headerSession)) {
      const response = await send(method, route, body, header);
      expect(response.status, `${route} for ${pathSession}`).toBe(200);
    }
  };

  let entered!: () => void;
  let release!: () => void;
  const enteredVerdict = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const update = store.updateArtifactStatus.bind(store);
  const delayed = vi.spyOn(store as IStore, "updateArtifactStatus").mockImplementationOnce(async (...args) => {
    entered();
    await blocked;
    return update(...args);
  });
  const admitted = send("POST", "artifacts/held/status", { status: "approved" });
  const marker = path.join(tmpDir, ".deeppairing", "sessions", sessionId, "review-ended.json");
  try {
    await Promise.race([enteredVerdict, admitted.then(() => { throw new Error("Verdict did not reach the hold."); })]);
    const ending = daemon.standaloneCloseout.end(sessionId);
    try {
      await assertRefusals("session_closing");
      expect(fs.existsSync(marker)).toBe(false);
      // Rejected stances are project memory: none yet, so the refusals wrote none.
      expect(store.getSessionMemory().rejectedApproaches).toEqual([]);
      // A sibling review and a wrapper session keep writing, even with the
      // closing review in the header of the path-scoped annotation writes.
      await assertAccepted(sibling.getSessionId(), sessionId);
      await assertAccepted(wrapper.getSessionId(), sessionId);
    } finally {
      release();
      await ending;
    }
    expect((await admitted).status).toBe(200);
    expect(fs.existsSync(marker)).toBe(true);
    const rows = JSON.parse(fs.readFileSync(path.join(path.dirname(marker), "artifacts.json"), "utf8"));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "held", status: "approved" }),
      expect.objectContaining({ id: "late", status: "draft" }),
    ]));
    const memoryBefore = store.getSessionMemory().rejectedApproaches;
    await assertRefusals("session_ended");

    // Nothing a refused write would have touched moved.
    expect(store.getArtifacts().find((a) => a.id === "late")?.status).toBe("draft");
    expect((store.getArtifacts().find((a) => a.id === "cs")?.content as { reviewState?: unknown }).reviewState ?? {}).toEqual({});
    expect(store.getSessionMemory().rejectedApproaches).toEqual(memoryBefore);
    expect(store.getCommentsForArtifact("late")).toEqual([]);
    expect(store.getUnacknowledgedRenderFailures()).toEqual([]);
    expect(fs.readFileSync(annotations, "utf8")).toBe(annotationsBefore);
    // The sibling's writes landed.
    expect(sibling.getArtifacts().find((a) => a.id === "late")?.status).toBe("rejected");
    expect(sibling.getUnacknowledgedRenderFailures()).toHaveLength(1);
  } finally {
    release();
    await admitted;
    delayed.mockRestore();
  }
});

it("releases End admission when a guarded browser write 404s, 400s, or throws (#711)", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const store = daemon.createSession(sessionId) as FileStore;
  seedReviewWriters(store);
  const { send } = reviewWriterHarness(tmpDir, daemon);
  const admission = vi.spyOn(daemon.standaloneCloseout, "admitWrite");
  const statusThrow = vi.spyOn(store as IStore, "updateArtifactStatus").mockImplementationOnce(() => {
    throw new Error("disk exploded");
  });
  const renderThrow = vi.spyOn(store, "recordRenderFailure").mockImplementationOnce(() => {
    throw new Error("disk exploded");
  });
  try {
    const failures = [
      [send("POST", "decisions/missing/options/o2/never-suggest", {}), 404],
      [send("POST", "decisions/d1/options/o1/never-suggest", {}), 400],
      [send("POST", "artifacts/late/changeset-review", { filePath: "auth/middleware.ts", state: "reviewed" }), 400],
      [send("POST", "artifacts/late/status", { status: "approved" }), 500],
      [send("POST", "render-failures", { artifactId: "late", visualId: "v1", error: "Parse error" }), 500],
      [send("DELETE", `sessions/${sessionId}/annotations/ann_missing`), 200],
    ] as const;
    for (const [pending, status] of failures) expect((await pending).status).toBe(status);
    // Each of these took (and must have released) admission.
    expect(admission.mock.results.filter(({ value }) => typeof value === "function")).toHaveLength(failures.length);
    const ended = await Promise.race([
      daemon.standaloneCloseout.end(sessionId).then(() => "ended"),
      sleep(5_000).then(() => "hung"),
    ]);
    expect(ended).toBe("ended");
    expect(daemon.standaloneCloseout.state(sessionId)).toMatchObject({ state: "ended" });
    expect(store.getArtifacts().find((a) => a.id === "late")?.status).toBe("draft");
  } finally {
    statusThrow.mockRestore();
    renderThrow.mockRestore();
    admission.mockRestore();
  }
});

it("answers a path-named standalone review with no directory as a typed 404, creating nothing (#711)", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  daemon.createSession(sessionId);
  const ghost = createStandaloneSessionId(tmpDir);
  const ghostDir = path.join(tmpDir, ".deeppairing", "sessions", ghost);
  const { send } = reviewWriterHarness(tmpDir, daemon);
  for (const [method, route, body] of [
    ["POST", `sessions/${ghost}/annotations`, { targetEventId: "evt_1", note: "Lost note" }],
    ["DELETE", `sessions/${ghost}/annotations/ann_existing`, undefined],
  ] as const) {
    const response = await send(method, route, body, sessionId);
    expect(response.status, route).toBe(404);
    expect(await response.json(), route).toMatchObject({ code: ERROR_CODES.session_not_found });
  }
  expect(fs.existsSync(ghostDir)).toBe(false);
  await daemon.standaloneCloseout.end(sessionId);
  expect(daemon.standaloneCloseout.state(sessionId)).toMatchObject({ state: "ended" });
});

it("wakes only the ended review's exact decision waiters after the marker commits", async () => {
  const { tmpDir, daemon } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const siblingId = createStandaloneSessionId(tmpDir);
  const store = daemon.createSession(sessionId);
  const sibling = daemon.createSession(siblingId);
  for (const [source, id] of [[store, "pending"], [store, "closed"], [store, "picked"], [sibling, "pending"]] as const) {
    source.createArtifact({ id: `art_${id}`, type: "decision", title: "Which cache?", content: { decisionId: id } });
    source.recordDecisionRequest({ decisionId: id, artifactId: `art_${id}`, context: "Which cache?", options: OPTS });
  }
  store.updateArtifactStatus("art_closed", "obsolete", "agent_obsolete");
  const headers = {
    "X-Project-Hash": projectHashOf(tmpDir), "X-Session-Id": sessionId,
    "Content-Type": "application/json", Authorization: "Bearer test-token",
  };
  const picked = await daemon.app.request("/api/decisions/picked", {
    method: "POST", headers, body: JSON.stringify({ optionId: "o2" }),
  });
  expect(picked.status).toBe(200);
  store.forceFlush();
  const dir = path.join(tmpDir, ".deeppairing", "sessions", sessionId);
  const decisionFile = path.join(dir, "decisions.json");
  const decisionsBefore = fs.readFileSync(decisionFile, "utf8");
  const cancel = new AbortController();
  const read = (sid: string, decisionId: string, waitMs?: number) =>
    daemon.app.request(`/api/internal/sessions/${sid}/read-decision`, {
      method: "POST", headers: { ...headers, "X-Session-Id": sid }, signal: cancel.signal,
      body: JSON.stringify({ expectedProjectRoot: tmpDir, decisionId, waitMs }),
    });
  const waiters = (source: typeof store) =>
    (source as unknown as { feedbackWaiters: Array<() => void> }).feedbackWaiters;

  try {
    const generalPending = store.waitForFeedback(10_000, cancel.signal);
    const [generalWaiter] = waiters(store);
    const pending = read(sessionId, "pending", 10_000);
    const otherPending = read(siblingId, "pending", 10_000);
    await vi.waitFor(() => {
      expect(waiters(store)).toHaveLength(2);
      expect(waiters(sibling)).toHaveLength(1);
    });
    const before = [...waiters(store)];
    const siblingBefore = [...waiters(sibling)];
    const flush = vi.spyOn(store, "forceFlush").mockImplementationOnce(() => { throw new Error("End flush failed"); });
    try {
      await expect(daemon.standaloneCloseout.end(sessionId)).rejects.toThrow("End flush failed");
      expect(waiters(store)).toEqual(before);
    } finally {
      flush.mockRestore();
    }
    const marker = await daemon.standaloneCloseout.end(sessionId);
    expect(waiters(store)).toEqual([generalWaiter]);
    expect(waiters(sibling)).toEqual(siblingBefore);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "review-ended.json"), "utf8"))).toEqual(marker);
    expect(fs.readFileSync(decisionFile, "utf8")).toBe(decisionsBefore);
    const ended = await (await pending).json();
    expect(ended).toMatchObject({ waitStatus: "session_ended", artifactStatus: "draft", decisionId: "pending", sessionId });
    expect(ended).not.toHaveProperty("selectedOptionId");
    expect(await (await read(sessionId, "pending", 10_000)).json()).toEqual(ended);
    expect(await (await read(sessionId, "pending")).json()).not.toHaveProperty("waitStatus");
    expect(await (await read(sessionId, "closed", 10_000)).json()).toMatchObject({ waitStatus: "closed" });
    expect(await (await read(sessionId, "picked", 10_000)).json()).toMatchObject({ waitStatus: "resolved", selectedOptionId: "o2" });
    expect((await read(sessionId, "unknown", 10_000)).status).toBe(404);
    expect(await daemon.standaloneCloseout.end(sessionId)).toEqual(marker);
    expect(fs.readFileSync(decisionFile, "utf8")).toBe(decisionsBefore);
    expect(waiters(store)).toHaveLength(1);
    expect(waiters(sibling)).toHaveLength(1);
    cancel.abort();
    await Promise.all([otherPending, generalPending]);
  } finally {
    cancel.abort();
  }
});

it("reads bounded feedback from one warm page version without activity, a lease, or acknowledgement", async () => {
  vi.useFakeTimers();
  const { tmpDir, daemon, exits } = makeDaemon();
  const sessionId = createStandaloneSessionId(tmpDir);
  const headers = {
    "X-Project-Hash": projectHashOf(tmpDir), "X-Session-Id": sessionId,
    "Content-Type": "application/json", Authorization: "Bearer test-token",
  };
  const sessionPath = (id: string, route: string) => `/api/internal/sessions/${id}/${route}`;
  const post = (url: string, body: object, auth = headers.Authorization) => daemon.app.request(url, {
    method: "POST", headers: { ...headers, Authorization: auth }, body: JSON.stringify(body),
  });
  const request = (id = sessionId, artifactId = "page1", project = tmpDir, auth?: string) =>
    post(sessionPath(id, "read-page-feedback"), { expectedProjectRoot: project, artifactId }, auth);
  fs.mkdirSync(path.join(tmpDir, ".deeppairing", "sessions", sessionId), { recursive: true });
  const cold = await request();
  expect(cold.status).toBe(404);
  expect(await cold.json()).toMatchObject({ error: expect.stringContaining(`deeppairing resume ${sessionId}`) });
  expect(daemon.sessions.size).toBe(0);
  expect((await request(sessionId, "page1", tmpDir, "")).status).toBe(401);
  expect((await request(sessionId, "page1", tmpDir + "-other")).status).toBe(403);
  expect((await request("s_legacy")).status).toBe(403);
  expect((await request(createStandaloneSessionId(tmpDir))).status).toBe(404);

  expect((await post(sessionPath(sessionId, "open-review"), { expectedProjectRoot: tmpDir, mode: "resume" })).status).toBe(200);
  const store = daemon.sessions.get(sessionId)!;
  const lastActivity = daemon.sessionMeta.get(sessionId)!.lastActivity;
  const htmlAnchor = { kind: "link" as const, quote: "Replay docs", locator: "a", href: "/replay", prefix: "See ", suffix: ".", version: 1 };
  store.createArtifact({ id: "page1", type: "page", title: "Replay", content: {} });
  store.createArtifact({ id: "page2", type: "page", title: "Replay v2", content: {}, parentId: "page1", version: 2 });
  store.createArtifact({ id: "option", type: "decision", title: "Option", content: {} });
  store.updateArtifactStatus("page1", "approved");
  const add = (id: string, content: string, artifactId = "page1", version = 1, author: "human" | "agent" = "human") =>
    store.addComment({
      id, content, artifactId, author, target: { artifactId, htmlAnchor: { ...htmlAnchor, version } },
      intent: "question", parentCommentId: "thread_parent",
    });
  add("a_huge", "🙂".repeat(17_000));
  add("b_answered", "Already acknowledged");
  store.acknowledgeComments(["b_answered"]);
  add("c_agent", "Agent reply", "page1", 1, "agent");
  add("e_successor", "On v2", "page2", 2);
  for (let n = 0; n < 50; n++) add(`small_${n}`, `Question ${n}`);
  vi.advanceTimersByTime(1);
  add("f_question", "Which replay procedure do we use?", "page1", 2);

  vi.advanceTimersByTime(49_999);
  const response = await request();
  expect(response.status).toBe(200);
  const raw = await response.text();
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(64 * 1024);
  const snapshot = JSON.parse(raw);
  expect(snapshot).toMatchObject({
    sessionId, artifact: { id: "page1", version: 1, status: "approved" },
    successor: { id: "page2", version: 2, status: "draft" }, omittedComments: 2,
  });
  expect(snapshot.comments).toHaveLength(50);
  expect(snapshot.comments[0]).toEqual({
    id: "f_question", content: "Which replay procedure do we use?", intent: "question",
    parentCommentId: "thread_parent", followUp: true, htmlAnchor: { ...htmlAnchor, version: 2 },
  });
  expect(await (await request()).text()).toBe(raw);
  expect((await request(sessionId, "option")).status).toBe(404);
  const sibling = createStandaloneSessionId(tmpDir);
  daemon.createSession(sibling);
  expect((await request(sibling)).status).toBe(404);
  expect(daemon.activeSessions.size).toBe(0);
  expect(daemon.sessionMeta.get(sessionId)?.lastActivity).toBe(lastActivity);
  expect(store.getUnacknowledgedComments().map((comment) => comment.id)).toContain("f_question");
  vi.advanceTimersByTime(10_000);
  expect(exits).toEqual([0]);
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
  it("#430 PR 1a — the web attention selector's Decide lane counts exactly what the daemon badge counts", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const store = daemon.createSession("s_attention");
    let i = 0;
    // A draft of every type the server knows, plus the two read-only kinds…
    for (const type of [...PENDING_DRAFT_TYPES, "explainer", "debrief", "reasoning"]) {
      store.createArtifact({ id: `att_${i++}`, type, title: `${type} draft`, content: {} });
    }
    // …and every reviewable type again, moved OFF draft (must count in neither).
    for (const type of PENDING_DRAFT_TYPES) {
      const id = `att_${i++}`;
      store.createArtifact({ id, type, title: `${type} done`, content: {} });
      store.updateArtifactStatus(id, i % 2 ? "approved" : "revised");
    }
    // Review (#445) — both counts span EVERY session: a second session holds a
    // pending decision, a read-only explainer and a resolved plan. Its artifacts
    // are foreign-session drafts relative to the first store — exactly what the
    // web merges into one list (MultiAgentSync) — so the cross-session sum is pinned.
    const other = daemon.createSession("s_attention_other");
    other.createArtifact({ id: "other_dec", type: "decision", title: "other decision", content: {} });
    other.createArtifact({ id: "other_exp", type: "explainer", title: "other explainer", content: {} });
    other.createArtifact({ id: "other_plan", type: "plan", title: "other plan", content: {} });
    other.updateArtifactStatus("other_plan", "approved");
    const res = await daemon.app.request("/api/daemon-info", {
      headers: { "X-Project-Hash": projectHashOf(tmpDir) },
    });
    expect(res.status).toBe(200);
    const merged = [...store.getArtifacts(), ...other.getArtifacts()];
    expect(new Set(merged.map((a) => a.sessionId))).toEqual(new Set(["s_attention", "s_attention_other"]));
    const attention = computeAttention({ artifacts: merged });
    expect((await res.json()).pendingCount).toBe(attention.lanes.decide.length);
    expect(attention.lanes.decide.length).toBe(PENDING_DRAFT_TYPES.length + 1);
  });

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

  it.each(["explainer", "debrief"] as const)("informational %s drafts do not lift the badge", async (type) => {
    const { tmpDir, daemon } = makeDaemon();
    const store = daemon.createSession("s_ex");
    store.createArtifact({
      id: "ex1", type, title: "How auth works here",
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
    store.createArtifact({ id: "cs1", type: "changeset", title: "Changeset", content: {} });
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

describe("#569 — a worker stop wakes the resolved session's parked check_feedback", () => {
  // Real FileStore + real waiter; only the fs.watch seam is faked so the test
  // can fire the hooks-state listener deterministically.
  function setup() {
    let listener: ((event: string, filename: string | null) => void) | undefined;
    const h = makeDaemon({
      watch: ((_dir: string, cb: (event: string, filename: string | null) => void) => {
        listener = cb;
        const w = new EventEmitter() as EventEmitter & { close(): void };
        w.close = () => {};
        return w;
      }) as unknown as CreateDaemonDeps["watch"],
    });
    const store = h.fx.track(new FileStore(h.tmpDir, "session_alpha_claude-aaa"));
    h.daemon.sessions.set("session_alpha_claude-aaa", store);
    h.daemon.startHooksWatcher();
    expect(listener).toBeDefined();
    const fire = (id: string, gate: Record<string, unknown>) => {
      const sp = path.join(h.tmpDir, ".deeppairing", "hooks-state.json");
      const prior = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf-8")) : {};
      const rec = {
        at: new Date().toISOString(), hook: "preflight", kind: "ask", id,
        gate: { decision: "ask", source: "session", concept: "wake test concept", tool: "Write", target: "src/x.ts", ...gate },
      };
      fs.writeFileSync(sp, JSON.stringify({ ...prior, fires: [...(prior.fires ?? []), rec] }));
      listener!("change", "hooks-state.json");
    };
    // Park a waiter; report whether it was woken (vs timing out).
    const park = () => {
      const t0 = Date.now();
      let wokeEarly: boolean | undefined;
      void store.waitForFeedback(400).then(() => { wokeEarly = Date.now() - t0 < 300; });
      return () => wokeEarly;
    };
    return { store, fire, park };
  }

  it("a worker stop (agentId, resolved session) wakes that session's waiter", async () => {
    const { fire, park } = setup();
    const woke = park();
    fire("hf_wake_worker", { session: "claude-aaa", agentId: "agent-1", agentType: "Explore" });
    await sleep(50);
    expect(woke()).toBe(true);
  });

  it("no wake for a main-agent entry (no agentId) on a resolved session", async () => {
    const { fire, park } = setup();
    const woke = park();
    fire("hf_wake_main", { session: "claude-aaa" });
    await sleep(100);
    expect(woke()).toBeUndefined();
  });

  it("no wake for a \"hook\"-session entry (unresolvable Claude session) even with an agentId", async () => {
    const { fire, park } = setup();
    const woke = park();
    fire("hf_wake_hook", { session: "claude-unknown", agentId: "agent-2" });
    await sleep(100);
    expect(woke()).toBeUndefined();
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
  it("late client-close idle checks cannot re-arm cleanup after disposal", () => {
    vi.useFakeTimers();
    const { daemon, exits, releases } = makeDaemon();
    daemon.checkAutoShutdown();
    expect(vi.getTimerCount()).toBe(1);
    daemon.dispose();
    // Both WS close handlers call this after removing their last client.
    // A close event already queued at disposal must remain harmless.
    daemon.checkAutoShutdown();
    daemon.checkAutoShutdown();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(61_000);
    expect(exits).toEqual([]);
    expect(releases).toEqual([]);
  });

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
    // heartbeat + ping + idle, plus #544's hooks-state stat poll.
    expect(vi.getTimerCount()).toBe(4);
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

describe("cleanup failure isolation", () => {
  it("flushes later sessions and removes discovery state when one session is conflicted", () => {
    const { daemon, tmpDir, logs } = makeDaemon();
    const failed = daemon.createSession("failed");
    const healthy = daemon.createSession("healthy");
    const failure = Object.assign(new Error("review conflict"), { code: "ESESSIONREVIEWCONFLICT" });
    vi.spyOn(failed, "forceFlush").mockImplementation(() => { throw failure; });
    const healthyFlush = vi.spyOn(healthy, "forceFlush");
    const daemonInfo = path.join(tmpDir, ".deeppairing", "daemon.json");
    daemon.writeDaemonInfo(45123);

    expect(() => daemon.cleanup()).not.toThrow();
    expect(healthyFlush).toHaveBeenCalledOnce();
    expect(fs.existsSync(daemonInfo)).toBe(false);
    expect(logs.some((line) => line.includes("failed") && line.includes("review conflict"))).toBe(true);
  });

  it("#425 review: cleanup never deletes ANOTHER daemon's daemon.json", () => {
    const { daemon, tmpDir } = makeDaemon();
    const daemonInfo = path.join(tmpDir, ".deeppairing", "daemon.json");
    daemon.writeDaemonInfo(45123);
    const mine = JSON.parse(fs.readFileSync(daemonInfo, "utf-8"));

    // The live daemon (a different process, or a later daemon in this same
    // process) has since overwritten the discovery file.
    for (const foreign of [
      { ...mine, pid: mine.pid + 1 },
      { ...mine, instanceId: "0".repeat(24) },
      { pid: mine.pid, port: 45124 }, // no instance id at all
    ]) {
      const bytes = JSON.stringify(foreign);
      fs.writeFileSync(daemonInfo, bytes);
      daemon.cleanup();
      expect(fs.readFileSync(daemonInfo, "utf-8")).toBe(bytes);
    }

    // Two daemons in one process (same pid): each removes only its own file.
    const other = makeDaemon({ projectRoot: tmpDir } as Partial<CreateDaemonDeps>);
    other.daemon.writeDaemonInfo(45125);
    daemon.cleanup();
    expect(JSON.parse(fs.readFileSync(daemonInfo, "utf-8")).port).toBe(45125);
    other.daemon.cleanup();
    expect(fs.existsSync(daemonInfo)).toBe(false);
    expect(mine).toMatchObject({ pid: process.pid, instanceId: expect.stringMatching(/^[0-9a-f]{24}$/) });
  });

  it("maps a frozen internal state read to an actionable conflict response", async () => {
    const { daemon, tmpDir, fx } = makeDaemon();
    const local = daemon.createSession("conflicted");
    local.createArtifact({
      id: "plan",
      type: "plan",
      title: "Plan",
      content: { steps: [{ title: "Old", status: "pending" }] },
    });
    local.forceFlush();
    const external = fx.track(new FileStore(tmpDir, "conflicted"));
    const changed = external.getArtifacts()[0]!;
    changed.content = { steps: [{ title: "New", status: "pending" }] };
    changed.version = 2;
    external.renameArtifact("plan", changed.title);
    external.forceFlush();
    local.updateArtifactStatus("plan", "approved", "ui_approve_button");
    expect(() => local.forceFlush()).toThrow(/changed content.*review verdict|review verdict.*changed content/i);

    const response = await daemon.app.request("/api/internal/sessions/conflicted/state", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: ERROR_CODES.session_review_conflict,
      message: expect.stringMatching(/restart.*review/i),
    });

    const liveResponse = await daemon.app.request("/api/live-session/conflicted", {
      headers: { "X-Project-Hash": projectHashOf(tmpDir) },
    });
    expect(liveResponse.status).toBe(409);
    expect(await liveResponse.json()).toMatchObject({ code: ERROR_CODES.session_review_conflict });
  });

  it("returns 409 before an internal decision resolution becomes durable", async () => {
    const { daemon, tmpDir, fx } = makeDaemon();
    const local = daemon.createSession("decision-conflict");
    local.createArtifact({
      id: "decision-card",
      type: "decision",
      title: "Which cache?",
      content: { decisionId: "cache", question: "Which cache?", options: OPTS },
    });
    local.recordDecisionRequest({
      decisionId: "cache", artifactId: "decision-card", context: "Which cache?", options: OPTS,
    });
    local.forceFlush();

    const contentWriter = fx.track(new FileStore(tmpDir, "decision-conflict"));
    const changed = contentWriter.getArtifacts()[0]!;
    changed.content = { decisionId: "cache", question: "Which queue?", options: OPTS };
    changed.version = 2;
    contentWriter.renameArtifact("decision-card", changed.title);
    contentWriter.forceFlush();

    const response = await daemon.app.request("/api/internal/sessions/decision-conflict/decisions/cache/resolve", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "o1", reasoning: "Fits the old cache question" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: ERROR_CODES.session_review_conflict });

    const recovered = fx.track(new FileStore(tmpDir, "decision-conflict"));
    expect(recovered.getArtifacts()[0]).toMatchObject({ status: "draft", version: 2 });
    expect(recovered.getDecisionResponse("cache")).toBeNull();
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

/**
 * Q2 — the broadcast tap persists a gate block.
 *
 * The daemon's `broadcast` is the one point every block passes through (the
 * same reason the metrics tap lives there), so it is where durability belongs.
 * Round 12's finding was that NOTHING persisted a real block: a 12s toast, an
 * in-memory browser store, and a metrics counter with no detail. These drive
 * the REAL factory's broadcast and read the file back off disk.
 */
describe("Q2 — createDaemon's broadcast tap writes the durable block log", () => {
  const BLOCK_EVENT = {
    type: "preflight_blocked",
    toolName: "present_code_change",
    source: "session",
    match: {
      concept: "global mutable state for config",
      proposal: "add a global mutable config singleton",
      reason: "it makes every test order-dependent",
      via: "concept",
    },
  };

  function readLog(tmpDir: string): Array<Record<string, unknown>> {
    const file = path.join(tmpDir, ".deeppairing", "preflight-blocks.json");
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf-8")).blocks;
  }

  it("persists a block broadcast with NO WebSocket client attached — the case that used to vanish", async () => {
    const { tmpDir, daemon } = makeDaemon();
    expect(daemon.getClientCount()).toBe(0);
    daemon.broadcast("session_alpha", BLOCK_EVENT);

    const blocks = readLog(tmpDir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.concept).toBe("global mutable state for config");
    expect(blocks[0]!.sessionId).toBe("session_alpha");

    // ...and it's served straight back for a later page load.
    const res = await daemon.app.request("/api/preflight-blocks", {
      headers: { "X-Project-Hash": projectHashOf(tmpDir) },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).blocks).toHaveLength(1);
  });

  it("DEMO sessions leave the project log untouched — the replay path is unchanged", () => {
    const { tmpDir, daemon } = makeDaemon();
    daemon.broadcast(`demo_${Date.now()}`, BLOCK_EVENT);
    expect(readLog(tmpDir)).toEqual([]);
  });

  it("ignores every other broadcast type (the tap sees them all)", () => {
    const { tmpDir, daemon } = makeDaemon();
    daemon.broadcast("session_alpha", { type: "artifact_created", artifact: { id: "a1" } });
    daemon.broadcast("session_alpha", { type: "comment_added", comment: { id: "c1" } });
    expect(readLog(tmpDir)).toEqual([]);
  });

  it("the internal sink broadcasts + persists a block routed from the MCP-server process", async () => {
    const { tmpDir, daemon } = makeDaemon();
    daemon.createSession("session_alpha");
    const res = await daemon.app.request("/api/internal/sessions/session_alpha/preflight-block", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
        "X-Project-Hash": projectHashOf(tmpDir),
      },
      body: JSON.stringify(BLOCK_EVENT),
    });
    expect(res.status).toBe(200);
    expect(readLog(tmpDir)).toHaveLength(1);
  });

  it("the internal sink refuses anything that is not a preflight block (no arbitrary WS injection)", async () => {
    const { tmpDir, daemon } = makeDaemon();
    daemon.createSession("session_alpha");
    const res = await daemon.app.request("/api/internal/sessions/session_alpha/preflight-block", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
        "X-Project-Hash": projectHashOf(tmpDir),
      },
      body: JSON.stringify({ type: "session_renamed", title: "pwned" }),
    });
    expect(res.status).toBe(400);
    expect(readLog(tmpDir)).toEqual([]);
  });
});

/**
 * #338 (F1) — through the REAL factory wiring: a frozen session's artifact
 * create/revise routes must refuse with the typed 409 and leave no receipt,
 * while an independent comment still lands.
 */
const checkpointPath = (root: string, sid: string, relFile: string) => path.join(
  root, ".deeppairing", "sessions", sid, "code-checkpoints",
  crypto.createHash("sha256").update(path.resolve(root, relFile)).digest("hex") + ".json",
);
const internal = (h: Harness, p: string, body?: unknown) => h.daemon.app.request(p, {
  method: "POST",
  headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("#338 (F1) — frozen artifact receipts through the real factory", () => {

  /** Seed a code_change parent in the daemon's own store, then freeze that
   *  store by racing its approval against an external content rewrite. */
  function freezeSession(h: Harness, sid: string): FileStore {
    const local = h.daemon.createSession(sid);
    local.createArtifact({
      id: "parent", type: "code_change", title: "Swap the cache",
      content: { filePath: "src/app.ts", diff: "-a\n+b" },
    });
    // #338 (P2) — an unreported reviewed notice, a resolved-but-unacked
    // decision, an unacked comment, and a render failure, all durable pre-freeze.
    local.createArtifact({ id: "notice", type: "research", title: "Reviewed notice", content: {} });
    local.updateArtifactStatus("notice", "approved", "ui_approve_button");
    local.recordDecisionRequest({ decisionId: "d", artifactId: "notice", context: "Choose", options: OPTS });
    local.resolveDecision("d", "o1");
    local.addComment({ id: "c-seed", artifactId: "parent", content: "Seed", author: "human" });
    local.recordRenderFailure({ artifactId: "parent", visualId: "v1", error: "boom" });
    local.forceFlush();
    const external = h.fx.track(new FileStore(h.tmpDir, sid));
    const changed = external.getArtifacts()[0]!;
    changed.content = { filePath: "src/app.ts", diff: "-a\n+REWRITTEN" };
    changed.version = 2;
    external.renameArtifact("parent", changed.title);
    external.forceFlush();
    local.updateArtifactStatus("parent", "approved", "ui_approve_button");
    expect(() => local.forceFlush()).toThrow(/changed content.*review verdict|review verdict.*changed content/i);
    return local;
  }

  it("refuses artifact creation on a frozen session: typed 409, no artifact, no checkpoint receipt", async () => {
    const h = makeDaemon();
    freezeSession(h, "frozen");
    const hintPath = path.join(h.tmpDir, ".deeppairing", "last-code-change.json");
    const hintBefore = fs.readFileSync(hintPath, "utf8");

    const res = await internal(h, "/api/internal/sessions/frozen/artifacts", {
      id: "after", type: "code_change", title: "Another change",
      content: { filePath: "src/new.ts", diff: "+x" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: ERROR_CODES.session_review_conflict });
    expect(fs.existsSync(checkpointPath(h.tmpDir, "frozen", "src/new.ts"))).toBe(false);
    expect(fs.readFileSync(hintPath, "utf8")).toBe(hintBefore);
    const recovered = h.fx.track(new FileStore(h.tmpDir, "frozen"));
    expect(recovered.getArtifacts().map((a) => a.id).sort()).toEqual(["notice", "parent"]);
  });

  it("refuses a revision on a frozen session and leaves the parent untouched", async () => {
    const h = makeDaemon();
    freezeSession(h, "frozen");
    const artifactsPath = path.join(h.tmpDir, ".deeppairing", "sessions", "frozen", "artifacts.json");
    const before = fs.readFileSync(artifactsPath, "utf8");

    const v2 = await internal(h, "/api/internal/sessions/frozen/artifacts", {
      id: "v2", type: "code_change", title: "Swap the cache", parentId: "parent", version: 3,
      content: { filePath: "src/app.ts", diff: "-a\n+c" },
    });
    expect(v2.status).toBe(409);
    const flip = await internal(h, "/api/internal/sessions/frozen/artifacts/parent/status",
      { status: "superseded", reason: "agent_supersede" });
    expect(flip.status).toBe(409);
    expect(await flip.json()).toMatchObject({ code: ERROR_CODES.session_review_conflict });

    expect(fs.readFileSync(artifactsPath, "utf8")).toBe(before);
    expect(JSON.parse(fs.readFileSync(checkpointPath(h.tmpDir, "frozen", "src/app.ts"), "utf8")))
      .toMatchObject({ artifactId: "parent" });
    const recovered = h.fx.track(new FileStore(h.tmpDir, "frozen"));
    expect(recovered.getArtifacts()).toHaveLength(2);
    expect(recovered.getArtifacts().find((a) => a.id === "parent")).toMatchObject({ status: "draft", version: 2 });
  });

  it("P2 — refuses status-change and decision acknowledgements on a frozen session; disk keeps reporting both", async () => {
    const h = makeDaemon();
    freezeSession(h, "frozen");
    const dir = path.join(h.tmpDir, ".deeppairing", "sessions", "frozen");
    const before = Object.fromEntries(["artifacts.json", "decisions.json"].map((n) => [n, fs.readFileSync(path.join(dir, n), "utf8")]));

    const statusAck = await internal(h, "/api/internal/sessions/frozen/artifacts/status-changes/acknowledge", { ids: ["notice"] });
    expect(statusAck.status).toBe(409);
    expect(await statusAck.json()).toMatchObject({ code: ERROR_CODES.session_review_conflict });
    const decisionAck = await internal(h, "/api/internal/sessions/frozen/decisions/acknowledge", { ids: ["d"] });
    expect(decisionAck.status).toBe(409);
    expect(await decisionAck.json()).toMatchObject({ code: ERROR_CODES.session_review_conflict });

    const flushed = await internal(h, "/api/internal/sessions/frozen/flush");
    expect(flushed.status).toBe(409);
    for (const [n, text] of Object.entries(before)) expect(fs.readFileSync(path.join(dir, n), "utf8")).toBe(text);
    const recovered = h.fx.track(new FileStore(h.tmpDir, "frozen"));
    expect(recovered.getUnacknowledgedStatusChanges().map((a) => a.id)).toEqual(["notice"]);
    expect(recovered.getResolvedDecisions().map((d) => d.decisionId)).toEqual(["d"]);
  });

  it("P2 — comment and render-failure acknowledgements still land on a frozen session", async () => {
    const h = makeDaemon();
    freezeSession(h, "frozen");
    const commentAck = await internal(h, "/api/internal/sessions/frozen/comments/acknowledge", { ids: ["c-seed"] });
    expect(commentAck.status).toBe(200);
    const renderAck = await internal(h, "/api/internal/sessions/frozen/render-failures/acknowledge",
      { keys: [{ artifactId: "parent", visualId: "v1" }] });
    expect(renderAck.status).toBe(200);
    expect((await internal(h, "/api/internal/sessions/frozen/flush")).status).toBe(409);
    const recovered = h.fx.track(new FileStore(h.tmpDir, "frozen"));
    expect(recovered.getCommentsForArtifact("parent").find((c) => c.id === "c-seed")?.acknowledged).toBe(true);
    expect(recovered.getUnacknowledgedRenderFailures()).toEqual([]);
  });

  it("still persists an independent comment on a frozen session", async () => {
    const h = makeDaemon();
    freezeSession(h, "frozen");
    const res = await internal(h, "/api/internal/sessions/frozen/comments",
      { id: "c-after", artifactId: "parent", content: "Still heard", author: "human" });
    expect(res.status).toBe(200);
    // The forced flush still refuses (typed) but writes the comment lane through.
    const flushed = await internal(h, "/api/internal/sessions/frozen/flush");
    expect(flushed.status).toBe(409);
    const recovered = h.fx.track(new FileStore(h.tmpDir, "frozen"));
    expect(recovered.getCommentsForArtifact("parent").map((c) => c.id)).toContain("c-after");
  });

});

/**
 * #338 (F4) — the two daemon `onError` handlers replaced Hono's default (which
 * printed the stack) with a bare generic 500. Unexpected errors must now reach
 * the daemon log with route + stack while the wire body stays generic.
 */
describe("#338 (F4) — unexpected route errors are logged, responses stay generic", () => {
  it("logs an unexpected internal-route error and keeps the 500 body generic", async () => {
    const h = makeDaemon();
    const store = h.daemon.createSession("boom");
    // A REAL unexpected error, no mock: mutating a disposed store throws.
    store.dispose();
    const res = await internal(h, "/api/internal/sessions/boom/artifacts",
      { id: "x", type: "research", title: "t", content: {} });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    const line = h.logs.find((l) => l.includes("[route-error]"));
    expect(line).toBeDefined();
    expect(line).toContain("POST /api/internal/sessions/boom/artifacts");
    expect(line).toMatch(/disposed/);
  });

  it("logs an unexpected active-session-route error and keeps the 500 body generic", async () => {
    const h = makeDaemon();
    // Real fake: a genuine FileStore whose state read throws a plain Error.
    class ExplodingStore extends FileStore {
      override getFullState(): never { throw new Error("state read exploded: secret-detail-7"); }
    }
    h.daemon.sessions.set("boom", h.fx.track(new ExplodingStore(h.tmpDir, "boom")));
    const res = await h.daemon.app.request("/api/live-session/boom", {
      headers: { "X-Project-Hash": projectHashOf(h.tmpDir) },
    });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "Internal server error" });
    expect(body).not.toContain("secret-detail-7");
    const line = h.logs.find((l) => l.includes("[route-error]"));
    expect(line).toContain("GET /api/live-session/boom");
    expect(line).toContain("secret-detail-7");
  });
});
