/**
 * #490 — two follow-ups to #484's settle/rollback, with REAL faults (a live
 * flush lock; a collection path that can't be written), no mocks:
 *
 *  1. An uncommitted settle must not wake waitForFeedback waiters (a spurious
 *     wake for every long-polling agent). A committed one still does.
 *  2. A disk error AFTER decisions.json landed (a later collection fails)
 *     leaves the answer DURABLE: the request is committed — 200, announced
 *     once, delivered — not a 503 for a decision that is resolved on disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { withHash } from "./routes.harness.js";
import { createHttpRoutes } from "../routes.js";
import { createDaemonRoutes, type SessionMeta } from "../../daemon/routes.js";
import { ownLockIdentity } from "../../store/file-lock.js";

const IDENTITY = ownLockIdentity()!;
const liveOwner = () => JSON.stringify({ ...IDENTITY, pid: process.ppid, processStartTime: null, createdAt: new Date().toISOString(), nonce: "live" });
const OPTS = [
  { id: "a", title: "A", description: "d", pros: [], cons: [], effort: "low" as const, risk: "low" as const, recommendation: true },
  { id: "b", title: "B", description: "d", pros: [], cons: [], effort: "low" as const, risk: "low" as const, recommendation: false },
];
const seedDecision = (store: FileStore) => {
  store.createArtifact({ id: "art_d", type: "decision", title: "Which?", content: { decisionId: "dec_d", question: "Which?", options: OPTS } });
  store.recordDecisionRequest({ decisionId: "dec_d", artifactId: "art_d", context: "Which?", options: OPTS });
};
const json = (body: unknown) => ({ method: "POST" as const, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sessionDir = (dir: string, sid: string) => path.join(dir, ".deeppairing", "sessions", sid);
const onDiskResponse = (dir: string, sid: string) => {
  const list = JSON.parse(fs.readFileSync(path.join(sessionDir(dir, sid), "decisions.json"), "utf8")) as Array<{ decisionId: string; response?: { optionId: string; reasoning?: string } }>;
  return list.find((d) => d.decisionId === "dec_d")?.response ?? null;
};
/** A real disk fault on a collection written AFTER decisions.json: the path is
 *  a directory, so the flush's read of it throws EISDIR. */
const breakPlanReviews = (dir: string, sid: string) => fs.mkdirSync(path.join(sessionDir(dir, sid), "plan-reviews.json"));

let fx: GlobalStoreFixture;
beforeEach(() => {
  fx = withGlobalStore("dp-resolve-settle-490-");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fx.dispose();
});

describe("#490.1 — an uncommitted settle wakes nobody", () => {
  it("a long-poll waiter is NOT woken by a resolve that 503s and rolls back; a committed retry wakes it", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_wake"));
    seedDecision(store);
    await store.forceFlush();
    const app = withHash(createHttpRoutes(store, fx.dir, () => {}), fx.dir);
    let woke = false;
    const waiter = store.waitForFeedback(5000).then(() => { woke = true; });

    const lock = path.join(sessionDir(fx.dir, "s_wake"), ".flush.lock");
    fs.writeFileSync(lock, liveOwner());
    expect((await app.request("/api/decisions/dec_d", json({ optionId: "a" }))).status).toBe(503);
    await new Promise((r) => setTimeout(r, 50));
    expect(woke).toBe(false);

    fs.unlinkSync(lock);
    expect((await app.request("/api/decisions/dec_d", json({ optionId: "a" }))).status).toBe(200);
    await waiter;
    expect(woke).toBe(true);
  });
});

describe("#490.2 — a partial write that landed the answer is a committed resolve", () => {
  it("public: decisions.json persisted, a later collection fails → 200, ONE event, delivered; disk resolved", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_part"));
    seedDecision(store);
    await store.forceFlush();
    const events: Array<Record<string, unknown>> = [];
    const app = withHash(createHttpRoutes(store, fx.dir, (m) => events.push(m as Record<string, unknown>)), fx.dir);
    breakPlanReviews(fx.dir, "s_part");
    store.recordPlanReview("art_other"); // dirty a collection flushed AFTER decisions.json

    const res = await app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "first" }));
    expect(onDiskResponse(fx.dir, "s_part")).toMatchObject({ optionId: "a", reasoning: "first" });
    expect(res.status).toBe(200); // was 503 while the answer was on disk
    const resolved = events.filter((e) => e.type === "decision_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ optionId: "a", reasoning: "first" });
    expect(store.getResolvedDecisions().map((d) => d.decisionId)).toContain("dec_d");

    // A retry is an ordinary no-op afterwards (no second event).
    fs.rmdirSync(path.join(sessionDir(fx.dir, "s_part"), "plan-reviews.json"));
    expect((await app.request("/api/decisions/dec_d", json({ optionId: "a" }))).status).toBe(200);
    expect(events.filter((e) => e.type === "decision_resolved")).toHaveLength(1);
  });

  it("internal: the same — 200 and one event when the answer landed despite the failed flush", async () => {
    const sessions = new Map<string, FileStore>();
    const meta = new Map<string, SessionMeta>();
    const events: Array<Record<string, unknown>> = [];
    const make = (sid: string) => { const s = fx.track(new FileStore(fx.dir, sid)); sessions.set(sid, s); return s; };
    const app = createDaemonRoutes(sessions, meta, make, (_sid, e) => events.push(e as Record<string, unknown>), undefined, fx.dir);
    await app.request("/api/internal/sessions/s_parti/register", json({}));
    const store = sessions.get("s_parti")!;
    seedDecision(store);
    await store.forceFlush();
    breakPlanReviews(fx.dir, "s_parti");
    store.recordPlanReview("art_other");

    const res = await app.request("/api/internal/sessions/s_parti/decisions/dec_d/resolve", json({ optionId: "a", reasoning: "first" }));
    expect(onDiskResponse(fx.dir, "s_parti")?.optionId).toBe("a");
    expect(res.status).toBe(200);
    expect(events.filter((e) => e.type === "decision_resolved")).toHaveLength(1);
  });
});
