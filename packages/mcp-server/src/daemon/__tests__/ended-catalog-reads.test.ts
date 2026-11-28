/**
 * #711 gates 5 and 6 — an ended standalone review is decided by its durable End
 * marker, never by membership in the daemon's live `sessions` map.
 *
 *  (5) The companion catalog moves an ended review to history even while its
 *      warm store is still installed, reports closing, and fails closed on a
 *      damaged marker.
 *  (6) The exact CLI reads (read-decision, read-page-feedback) of an ended
 *      review come from the load-only disk snapshot readers: byte-identical
 *      warm and cold, with no store, watch, lease, activity or file change.
 *
 * Fakes not mocks: a real daemon factory over a temp project, a recording
 * fake directory watcher, and on-disk tree snapshots.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DecisionOption } from "@deeppairing/shared";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { FileStore } from "../../store/file-store.js";
import { projectHashOf } from "../../project-root.js";
import { createStandaloneSessionId } from "../../standalone-session-id.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { ERROR_CODES } from "../../error-codes.js";

const OPTS: DecisionOption[] = [
  { id: "o1", title: "Redis", description: "d", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
  { id: "o2", title: "In-proc", description: "d", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
];

interface Harness { daemon: Daemon; watchCalls: string[] }
const fixtures: GlobalStoreFixture[] = [];
const daemons: Daemon[] = [];

function makeDaemon(projectRoot?: string): Harness & { tmpDir: string } {
  let tmpDir = projectRoot;
  if (!tmpDir) {
    const fx = withGlobalStore("dp-ended-catalog-");
    fixtures.push(fx);
    tmpDir = fx.dir;
  }
  const watchCalls: string[] = [];
  const daemon = createDaemon({
    projectRoot: tmpDir,
    authToken: "test-token",
    log: () => {},
    exitProcess: () => {},
    releaseListenSocket: () => {},
    env: {},
    // A recording fake: any watch registration a read caused would land here.
    pageWatch: { watch: (dir) => { watchCalls.push(dir); return { close() {} }; }, pollIntervalMs: 0 },
  });
  daemons.push(daemon);
  return { tmpDir, daemon, watchCalls };
}

afterEach(() => {
  for (const daemon of daemons.splice(0)) {
    for (const store of daemon.sessions.values()) store.dispose();
    daemon.dispose();
  }
  for (const fx of fixtures.splice(0)) fx.dispose();
});

/** Every entry under root, with content digests and mtimes (directories too,
 *  so even a transient temp-file write would show). */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        out[rel] = `dir ${stat.mtimeMs}`;
        walk(full);
      } else {
        out[rel] = `file ${stat.mtimeMs} ${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`;
      }
    }
  };
  walk(root);
  return out;
}

function client(daemon: Daemon, tmpDir: string) {
  const headers = { "X-Project-Hash": projectHashOf(tmpDir), "Content-Type": "application/json", Authorization: "Bearer test-token" };
  const post = (sessionId: string, route: string, body: object) =>
    daemon.app.request(`/api/internal/sessions/${sessionId}/${route}`, {
      method: "POST", headers: { ...headers, "X-Session-Id": sessionId }, body: JSON.stringify({ expectedProjectRoot: tmpDir, ...body }),
    });
  return {
    catalog: async () => (await daemon.app.request("/api/active-sessions", { headers })).json() as Promise<{
      sessions: Array<{ sessionId: string; reviewState?: string }>;
      endedSessions?: Array<{ sessionId: string; title: string; endedAt: string }>;
      unverifiedSessions?: Array<{ sessionId: string; code: string }>;
    }>,
    live: (sessionId: string) => daemon.app.request(`/api/live-session/${sessionId}`, { headers }),
    internalList: async () => ((await (await daemon.app.request("/api/internal/sessions", { headers })).json()) as {
      sessions: Array<{ sessionId: string }>;
    }).sessions.map((s) => s.sessionId),
    readDecision: (sessionId: string, decisionId: string, waitMs?: number) => post(sessionId, "read-decision", { decisionId, waitMs }),
    readPage: (sessionId: string, artifactId: string) => post(sessionId, "read-page-feedback", { artifactId }),
  };
}

describe("#711 gate 5 — the catalog decides End from the durable marker", () => {
  it("reports closing, then moves an ended warm review to history and never serves its live entry", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const api = client(daemon, tmpDir);
    const sessionId = createStandaloneSessionId(tmpDir);
    const siblingId = createStandaloneSessionId(tmpDir);
    const store = daemon.createSession(sessionId);
    store.createArtifact({ id: "a1", type: "research", title: "Ended review", content: {} });
    daemon.createSession(siblingId).createArtifact({ id: "s1", type: "research", title: "Sibling", content: {} });
    daemon.createSession("s_wrapper").createArtifact({ id: "w1", type: "research", title: "Wrapper", content: {} });

    const open = await api.catalog();
    expect(open.sessions.find((s) => s.sessionId === sessionId)).toMatchObject({ reviewState: "open" });
    expect(open.sessions.find((s) => s.sessionId === "s_wrapper")).not.toHaveProperty("reviewState");
    expect(open).not.toHaveProperty("endedSessions");

    // Hold an admitted writer so End stays in its closing phase.
    const release = daemon.standaloneCloseout.admitWrite(sessionId)!;
    const ending = daemon.standaloneCloseout.end(sessionId);
    await new Promise((resolve) => setImmediate(resolve));
    const closing = await api.catalog();
    expect(closing.sessions.find((s) => s.sessionId === sessionId)).toMatchObject({ reviewState: "closing" });
    expect(closing).not.toHaveProperty("endedSessions");
    release();
    const marker = await ending;

    // The warm store is still installed; the marker alone decides.
    expect(daemon.sessions.get(sessionId)).toBe(store);
    const ended = await api.catalog();
    expect(ended.sessions.map((s) => s.sessionId).sort()).toEqual([siblingId, "s_wrapper"].sort());
    expect(ended.sessions.find((s) => s.sessionId === siblingId)).toMatchObject({ reviewState: "open" });
    expect(ended.endedSessions).toEqual([{ sessionId, title: sessionId, endedAt: marker.endedAt }]);
    expect(ended).not.toHaveProperty("unverifiedSessions");

    const live = await api.live(sessionId);
    expect(live.status).toBe(409);
    const liveBody = await live.json() as Record<string, unknown>;
    expect(liveBody).toMatchObject({ code: ERROR_CODES.session_ended, endedAt: marker.endedAt });
    expect(liveBody).not.toHaveProperty("artifacts");
    expect((await api.live(siblingId)).status).toBe(200);
    expect((await api.live("s_wrapper")).status).toBe(200);
    expect(await api.internalList()).not.toContain(sessionId);
    expect(await api.internalList()).toContain(siblingId);
    expect(daemon.sessions.get(sessionId)).toBe(store);
  });

  it("fails closed on a damaged marker: never attachable, typed session_marker_invalid", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const api = client(daemon, tmpDir);
    const sessionId = createStandaloneSessionId(tmpDir);
    const store = daemon.createSession(sessionId);
    store.createArtifact({ id: "page1", type: "page", title: "Page", content: {} });
    store.createArtifact({ id: "decision", type: "decision", title: "Pick", content: { decisionId: "d1" } });
    store.recordDecisionRequest({ decisionId: "d1", artifactId: "decision", context: "Pick", options: OPTS });
    await daemon.standaloneCloseout.end(sessionId);
    fs.writeFileSync(path.join(tmpDir, ".deeppairing", "sessions", sessionId, "review-ended.json"), "{ damaged");

    const catalog = await api.catalog();
    expect(catalog.sessions.map((s) => s.sessionId)).not.toContain(sessionId);
    expect(catalog.unverifiedSessions).toEqual([{ sessionId, code: ERROR_CODES.session_marker_invalid }]);
    expect(catalog).not.toHaveProperty("endedSessions");
    for (const response of [await api.live(sessionId), await api.readPage(sessionId, "page1"),
      await api.readDecision(sessionId, "d1"), await api.readDecision(sessionId, "d1", 1_000)]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: ERROR_CODES.session_marker_invalid });
    }
    expect(await api.internalList()).not.toContain(sessionId);
  });
});

describe("#711 — the daemon-info badges skip a durably ended review", () => {
  it("drops pending and unanswered counts to 0 after End with the warm store installed, and fails closed on a damaged marker", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const sessionId = createStandaloneSessionId(tmpDir);
    const store = daemon.createSession(sessionId);
    store.createArtifact({ id: "plan", type: "plan", title: "Plan", content: { steps: [] } });
    store.addComment({ id: "q1", artifactId: "plan", content: "Why this order?", author: "human", intent: "question" });
    const info = async () => (await daemon.app.request("/api/daemon-info", { headers: { "X-Project-Hash": projectHashOf(tmpDir) } })).json() as
      Promise<{ pendingCount: number; unansweredQuestionCount: number }>;
    expect(await info()).toMatchObject({ pendingCount: 1, unansweredQuestionCount: 1 });
    await daemon.standaloneCloseout.end(sessionId);
    expect(daemon.sessions.get(sessionId)).toBe(store);
    expect(await info()).toMatchObject({ pendingCount: 0, unansweredQuestionCount: 0 });
    fs.writeFileSync(path.join(tmpDir, ".deeppairing", "sessions", sessionId, "review-ended.json"), "{ damaged");
    expect(await info()).toMatchObject({ pendingCount: 0, unansweredQuestionCount: 0 });
  });
});

describe("#711 gate 6 — CLI exact reads of an ended review come from disk snapshots", () => {
  function seed(store: FileStore): void {
    const htmlAnchor = { kind: "link" as const, quote: "Replay docs", locator: "a", href: "/replay", prefix: "See ", suffix: ".", version: 1 };
    store.createArtifact({ id: "page1", type: "page", title: "Replay", content: {} });
    store.addComment({ id: "c_anchor", content: "Which replay?", artifactId: "page1", author: "human",
      target: { artifactId: "page1", htmlAnchor }, intent: "question" });
    store.addComment({ id: "c_note", content: "Looks right overall", artifactId: "page1", author: "human" });
    for (const id of ["pending", "picked"]) {
      store.createArtifact({ id: `art_${id}`, type: "decision", title: "Which cache?", content: { decisionId: id } });
      store.recordDecisionRequest({ decisionId: id, artifactId: `art_${id}`, context: "Which cache?", options: OPTS });
    }
    store.resolveDecision("picked", "o2", "Keep it simple");
  }

  async function readAll(api: ReturnType<typeof client>, sessionId: string): Promise<Array<[number, string]>> {
    const out: Array<[number, string]> = [];
    for (const response of [
      await api.readPage(sessionId, "page1"),
      await api.readDecision(sessionId, "pending"),
      await api.readDecision(sessionId, "pending", 5_000),
      await api.readDecision(sessionId, "picked", 5_000),
      await api.readDecision(sessionId, "unknown"),
      await api.readPage(sessionId, "art_pending"),
    ]) out.push([response.status, await response.text()]);
    return out;
  }

  it("answers byte-identically warm and cold without touching stores, watches, activity, or files", async () => {
    const warm = makeDaemon();
    const { tmpDir, daemon } = warm;
    const api = client(daemon, tmpDir);
    const sessionId = createStandaloneSessionId(tmpDir);
    const store = daemon.createSession(sessionId);
    seed(store);
    // The live (pre-End) reads, for shape compatibility below.
    const livePage = await (await api.readPage(sessionId, "page1")).text();
    const liveDecision = await (await api.readDecision(sessionId, "pending")).text();
    await daemon.standaloneCloseout.end(sessionId);

    const before = tree(tmpDir);
    const sessionsBefore = [...daemon.sessions.entries()];
    const metaBefore = JSON.stringify([...daemon.sessionMeta.entries()]);
    const watchedBefore = daemon.pageWatcher.watched(sessionId);
    const warmReads = await readAll(api, sessionId);
    expect(tree(tmpDir)).toEqual(before);
    expect([...daemon.sessions.entries()]).toEqual(sessionsBefore);
    expect(JSON.stringify([...daemon.sessionMeta.entries()])).toBe(metaBefore);
    expect(daemon.activeSessions.size).toBe(0);
    expect(daemon.pageWatcher.watched(sessionId)).toEqual(watchedBefore);
    expect(warm.watchCalls).toEqual([]);

    expect(warmReads.map(([status]) => status)).toEqual([200, 200, 200, 200, 404, 404]);
    expect(warmReads[0]![1]).toBe(livePage);
    expect(warmReads[1]![1]).toBe(liveDecision);
    expect(JSON.parse(warmReads[2]![1])).toMatchObject({ decisionId: "pending", waitStatus: "session_ended", sessionId });
    expect(JSON.parse(warmReads[3]![1])).toMatchObject({ decisionId: "picked", waitStatus: "resolved", selectedOptionId: "o2" });
    expect(JSON.parse(warmReads[4]![1])).toMatchObject({ code: ERROR_CODES.decision_not_in_session });
    expect(JSON.parse(warmReads[5]![1])).toMatchObject({ code: ERROR_CODES.artifact_not_in_session });

    // A cold daemon over the same project: nothing installed, nothing warmed.
    const cold = makeDaemon(tmpDir);
    const coldApi = client(cold.daemon, tmpDir);
    const coldBefore = tree(tmpDir);
    const coldReads = await readAll(coldApi, sessionId);
    expect(coldReads).toEqual(warmReads);
    expect(tree(tmpDir)).toEqual(coldBefore);
    expect(cold.daemon.sessions.size).toBe(0);
    expect(cold.daemon.sessionMeta.size).toBe(0);
    expect(cold.daemon.activeSessions.size).toBe(0);
    expect(cold.daemon.pageWatcher.watched(sessionId)).toEqual([]);
    expect(cold.watchCalls).toEqual([]);
  });

  it("a snapshot cannot be written through a cast, and a snapshot-mode store refuses to flush", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const sessionId = createStandaloneSessionId(tmpDir);
    seed(daemon.createSession(sessionId));
    await daemon.standaloneCloseout.end(sessionId);
    const before = tree(tmpDir);
    const view = FileStore.openSessionSnapshot(tmpDir, sessionId)!;
    expect(Object.isFrozen(view)).toBe(true);
    const cast = view as unknown as FileStore;
    expect(() => cast.createArtifact({ id: "forged", type: "research", title: "Forged", content: {} })).toThrow(TypeError);
    expect(() => cast.forceFlush()).toThrow(TypeError);
    // Defence in depth: the underlying snapshot-mode instance refuses every flush path.
    const mode = (FileStore as unknown as { sessionSnapshot: symbol }).sessionSnapshot;
    const raw = new (FileStore as unknown as new (root: string, sid: string, mode: symbol) => FileStore)(tmpDir, sessionId, mode);
    expect(() => raw.createArtifact({ id: "forged", type: "research", title: "Forged", content: {} })).toThrow(/read-only/);
    expect(() => raw.forceFlush()).toThrow(/read-only/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(tree(tmpDir)).toEqual(before);
  });

  it("keeps a missing review directory a not-found and creates nothing", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const api = client(daemon, tmpDir);
    const missing = createStandaloneSessionId(tmpDir);
    fs.mkdirSync(path.join(tmpDir, ".deeppairing", "sessions"), { recursive: true });
    const before = tree(tmpDir);
    for (const response of [await api.readPage(missing, "page1"), await api.readDecision(missing, "d1", 1_000)]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: ERROR_CODES.session_not_registered });
    }
    expect(FileStore.openSessionSnapshot(tmpDir, missing)).toBeNull();
    expect(tree(tmpDir)).toEqual(before);
    expect(daemon.sessions.size).toBe(0);
  });

  it("fails closed when ended history was altered after End", async () => {
    const { tmpDir, daemon } = makeDaemon();
    const api = client(daemon, tmpDir);
    const sessionId = createStandaloneSessionId(tmpDir);
    seed(daemon.createSession(sessionId));
    await daemon.standaloneCloseout.end(sessionId);
    const decisions = path.join(tmpDir, ".deeppairing", "sessions", sessionId, "decisions.json");
    const rows = JSON.parse(fs.readFileSync(decisions, "utf8")) as Array<Record<string, unknown>>;
    fs.writeFileSync(decisions, JSON.stringify([...rows, { ...rows[0], artifactId: "foreign" }]));
    for (const response of [await api.readDecision(sessionId, "pending"), await api.readPage(sessionId, "page1")]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: ERROR_CODES.session_review_conflict });
    }
  });
});
