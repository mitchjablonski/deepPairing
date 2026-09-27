/**
 * #406/#408 review — a busy cross-process lock must surface as a clean 503
 * `lock_busy` with NOTHING committed, and a crashed owner's lock must not
 * wedge the route. Pre-fix, a reject with a held preferences.json.lock
 * committed status `rejected`, then 500'd recording the approach: the gate had
 * no memory of a rejection the agent could see, no artifact_updated went out,
 * and the UI rolled back to a state the server no longer held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { withHash } from "./routes.harness.js";
import { createHttpRoutes } from "../routes.js";
import { ERROR_CODES } from "../../error-codes.js";
import { ownLockIdentity } from "../../store/file-lock.js";

let fx: GlobalStoreFixture;
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;
let broadcasts: Array<Record<string, unknown>>;
let lock: string;

const IDENTITY = ownLockIdentity()!;
const liveOwner = () => JSON.stringify({ ...IDENTITY, pid: process.ppid, processStartTime: null, createdAt: new Date().toISOString(), nonce: "live" });
const deadOwner = () => JSON.stringify({ ...IDENTITY, pid: spawnSync(process.execPath, ["-e", ""]).pid, processStartTime: null, createdAt: "2020-01-01T00:00:00.000Z", nonce: "dead" });

beforeEach(() => {
  fx = withGlobalStore("dp-lock-busy-");
  store = fx.track(new FileStore(fx.dir, "test_session"));
  broadcasts = [];
  app = withHash(createHttpRoutes(store, fx.dir, (m) => broadcasts.push(m as Record<string, unknown>)), fx.dir);
  lock = path.join(fx.dir, ".deeppairing", "preferences.json.lock");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.unlinkSync(lock); } catch { /* released */ }
  fx.dispose();
});

const readPrefsRejections = () => {
  const p = path.join(fx.dir, ".deeppairing", "preferences.json");
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")).rejectedApproaches ?? []) : [];
};

const post = (url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("reject route under a busy preferences lock", () => {
  it("a live owner: 503 lock_busy and NOTHING committed (status, comment, rejection)", async () => {
    store.createArtifact({ id: "art_1", type: "plan", title: "Use Redis for sessions", content: {} });
    fs.writeFileSync(lock, liveOwner());

    const res = await post("/api/artifacts/art_1/status", { status: "rejected", feedback: "no new services", concept: "redis" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: ERROR_CODES.lock_busy, lockPath: lock });
    expect(body.message).toMatch(/doctor/);

    expect(store.getArtifacts().find((a) => a.id === "art_1")?.status).toBe("draft");
    expect(store.getComments()).toHaveLength(0);
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);
    expect(broadcasts.some((b) => b.type === "artifact_updated" || b.type === "ledger_write")).toBe(false);

    // The owner finishes: the UI's retry is a clean first attempt.
    fs.unlinkSync(lock);
    const retry = await post("/api/artifacts/art_1/status", { status: "rejected", feedback: "no new services", concept: "redis" });
    expect(retry.status).toBe(200);
    expect(store.getArtifacts().find((a) => a.id === "art_1")?.status).toBe("rejected");
    expect(store.getSessionMemory().rejectedApproaches.map((r) => r.concept)).toEqual(["redis"]);
  });

  it("a crashed owner (SIGKILLed mid-write): the reject recovers the lock and records", async () => {
    store.createArtifact({ id: "art_2", type: "plan", title: "Use Mongo", content: {} });
    fs.writeFileSync(lock, deadOwner());
    const res = await post("/api/artifacts/art_2/status", { status: "rejected", feedback: "relational data" });
    expect(res.status).toBe(200);
    expect(store.getArtifacts().find((a) => a.id === "art_2")?.status).toBe("rejected");
    expect(store.getSessionMemory().rejectedApproaches.map((r) => r.description)).toEqual(["Use Mongo"]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("M1: a reject that 409s session_review_conflict leaves preferences untouched and keeps the feedback", async () => {
    store.createArtifact({ id: "art_c", type: "plan", title: "Review this plan", content: { steps: [{ title: "Original", status: "pending" }] } });
    store.forceFlush();
    const prefsPath = path.join(fx.dir, ".deeppairing", "preferences.json");
    const before = fs.existsSync(prefsPath) ? fs.readFileSync(prefsPath, "utf8") : null;
    // Another writer rewrites the proposal the human is reviewing.
    const contentWriter = fx.track(new FileStore(fx.dir, "test_session"));
    const changed = contentWriter.getArtifacts()[0]!;
    changed.content = { steps: [{ title: "Unseen replacement", status: "pending" }] };
    changed.version = 2;
    contentWriter.renameArtifact("art_c", changed.title);
    contentWriter.forceFlush();

    const res = await post("/api/artifacts/art_c/status", { status: "rejected", feedback: "not this", concept: "original plan" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(ERROR_CODES.session_review_conflict);
    expect(fs.existsSync(prefsPath) ? fs.readFileSync(prefsPath, "utf8") : null).toBe(before);
    expect(readPrefsRejections()).toEqual([]);
    expect(broadcasts.some((b) => b.type === "ledger_write")).toBe(false);
    const recovered = fx.track(new FileStore(fx.dir, "test_session"));
    expect(recovered.getCommentsForArtifact("art_c").map((comment) => comment.content)).toContain("not this");
  });

  it("M1 residual: a conflict landing AFTER the preview retracts the row this request added", async () => {
    store.createArtifact({ id: "art_r", type: "plan", title: "Race me", content: { steps: [{ title: "Original", status: "pending" }] } });
    store.forceFlush();
    // Simulate the rewrite landing between the preview and the flush.
    vi.spyOn(store, "previewReviewConflict").mockImplementation(() => {
      const writer = fx.track(new FileStore(fx.dir, "test_session"));
      const art = writer.getArtifacts().find((a) => a.id === "art_r")!;
      art.content = { steps: [{ title: "Swapped", status: "pending" }] };
      art.version = 2;
      writer.renameArtifact("art_r", art.title);
      writer.forceFlush();
      return null;
    });
    const res = await post("/api/artifacts/art_r/status", { status: "rejected", feedback: "no" });
    expect(res.status).toBe(409);
    expect(readPrefsRejections()).toEqual([]);
  });

  it("preferences route: 503 lock_busy and the in-memory dial does not move", async () => {
    fs.writeFileSync(lock, liveOwner());
    const res = await post("/api/preferences", { autonomyLevel: "autonomous" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe(ERROR_CODES.lock_busy);
    expect(store.getAutonomyLevel()).toBe("supervised");
  });

  it("'none of these fit' send-back: 503 saves no comment, and the retry records every option", async () => {
    const options = ["Redis", "Memcached"].map((title, i) => ({
      id: `o${i}`, title, description: title, pros: [], cons: [], effort: "low", risk: "low", recommendation: false,
      concept: { name: `${title.toLowerCase()} cache` },
    }));
    store.createArtifact({ id: "art_dec", type: "decision", title: "Cache?", content: { context: "Cache?", options, decisionId: "d1" } } as never);
    const sendBack = () => post("/api/comments", {
      artifactId: "art_dec", content: "neither — no cache yet", intent: "question",
      target: { artifactId: "art_dec", sectionId: "decision_revision_requested" },
    });

    fs.writeFileSync(lock, liveOwner());
    const res = await sendBack();
    expect(res.status).toBe(503);
    expect(store.getComments()).toHaveLength(0);
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);

    fs.unlinkSync(lock);
    expect((await sendBack()).status).toBe(200);
    expect(store.getSessionMemory().rejectedApproaches.map((r) => r.concept).sort()).toEqual(["memcached cache", "redis cache"]);
    expect(broadcasts.filter((b) => b.type === "ledger_write")).toHaveLength(2);
  });
});
