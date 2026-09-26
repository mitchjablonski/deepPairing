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
import os from "node:os";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { withHash } from "./routes.harness.js";
import { createHttpRoutes } from "../routes.js";
import { ERROR_CODES } from "../../error-codes.js";

let fx: GlobalStoreFixture;
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;
let broadcasts: Array<Record<string, unknown>>;
let lock: string;

const liveOwner = () => JSON.stringify({ pid: process.ppid, hostname: os.hostname(), processStartTime: null, createdAt: new Date().toISOString(), nonce: "live" });
const deadOwner = () => JSON.stringify({ pid: spawnSync(process.execPath, ["-e", ""]).pid, hostname: os.hostname(), processStartTime: null, createdAt: "2020-01-01T00:00:00.000Z", nonce: "dead" });

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
