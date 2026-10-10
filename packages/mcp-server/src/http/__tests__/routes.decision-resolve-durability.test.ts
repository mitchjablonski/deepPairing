/**
 * #484 review — the atomic decision resolve's DURABILITY and TRANSPORT
 * contracts, with real stores, a real live-owner flush lock and a real daemon.
 *
 *  P2 — an idempotent same-choice success (or a refusal naming the winner) must
 *       report only what is PERSISTED. The first request writes the answer in
 *       memory and its flush fails (lock busy → 503); a queued retry used to
 *       see that unpersisted answer and answer 200 alreadyResolved while
 *       decisions.json still held the pending record. Both transports.
 *  P3 — DaemonClient.resolveDecisionAtomic maps the internal route's typed
 *       refusals back to outcomes, so createHttpRoutes(DaemonClient) answers a
 *       losing choice with the 409 + winner, not a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { withHash } from "./routes.harness.js";
import { createHttpRoutes } from "../routes.js";
import { createDaemonRoutes, type SessionMeta } from "../../daemon/routes.js";
import { createDaemon, type Daemon } from "../../daemon/create-daemon.js";
import { DaemonClient } from "../../daemon/client.js";
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
const onDiskResponse = (dir: string, sid: string) => {
  const p = path.join(dir, ".deeppairing", "sessions", sid, "decisions.json");
  const list = JSON.parse(fs.readFileSync(p, "utf8")) as Array<{ decisionId: string; response?: { optionId: string } }>;
  return list.find((d) => d.decisionId === "dec_d")?.response ?? null;
};
const json = (body: unknown) => ({ method: "POST" as const, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let fx: GlobalStoreFixture;
beforeEach(() => {
  fx = withGlobalStore("dp-resolve-durability-");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fx.dispose();
});

describe("P2 — a same-choice success never reports an unpersisted answer", () => {
  it("public route: with the session flush lock held, two same-choice requests are [503, 503] (was [503, 200]); after release, success is on disk", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_pub"));
    seedDecision(store);
    await store.forceFlush();
    const broadcasts: Array<Record<string, unknown>> = [];
    const app = withHash(createHttpRoutes(store, fx.dir, (m) => broadcasts.push(m as Record<string, unknown>)), fx.dir);
    const lock = path.join(fx.dir, ".deeppairing", "sessions", "s_pub", ".flush.lock");
    fs.writeFileSync(lock, liveOwner());

    const res = await Promise.all([
      app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "first" })),
      app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "retry" })),
    ]);
    expect(res.map((r) => r.status)).toEqual([503, 503]);
    expect(onDiskResponse(fx.dir, "s_pub")).toBeNull();
    expect(broadcasts.some((b) => b.type === "decision_resolved")).toBe(false);

    fs.unlinkSync(lock);
    const retry = await app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "retry" }));
    expect(retry.status).toBe(200);
    expect(onDiskResponse(fx.dir, "s_pub")?.optionId).toBe("a");
  });

  it("internal route: the same — no 200 while the answer isn't on disk", async () => {
    const sessions = new Map<string, FileStore>();
    const meta = new Map<string, SessionMeta>();
    const make = (sid: string) => { const s = fx.track(new FileStore(fx.dir, sid)); sessions.set(sid, s); return s; };
    const app = createDaemonRoutes(sessions, meta, make, () => {}, undefined, fx.dir);
    await app.request("/api/internal/sessions/s_int/register", json({}));
    const store = sessions.get("s_int")!;
    seedDecision(store);
    await store.forceFlush();
    const lock = path.join(fx.dir, ".deeppairing", "sessions", "s_int", ".flush.lock");
    fs.writeFileSync(lock, liveOwner());

    const res = await Promise.all([
      app.request("/api/internal/sessions/s_int/decisions/dec_d/resolve", json({ optionId: "a", reasoning: "first" })),
      app.request("/api/internal/sessions/s_int/decisions/dec_d/resolve", json({ optionId: "a", reasoning: "retry" })),
    ]);
    expect(res.map((r) => r.status)).toEqual([503, 503]);
    expect(onDiskResponse(fx.dir, "s_int")).toBeNull();

    fs.unlinkSync(lock);
    const retry = await app.request("/api/internal/sessions/s_int/decisions/dec_d/resolve", json({ optionId: "a" }));
    expect(retry.status).toBe(200);
    expect(onDiskResponse(fx.dir, "s_int")?.optionId).toBe("a");
  });
});

describe("P3 — createHttpRoutes(DaemonClient): a losing choice is the typed 409 with the winner", () => {
  let daemon: Daemon;
  let server: ReturnType<typeof serve>;
  afterEach(() => {
    daemon?.dispose();
    try { server?.close(); } catch { /* closed */ }
  });

  it("a real daemon + a real client + the public routes: [200, 409], the 409 carries the winner", async () => {
    daemon = createDaemon({ projectRoot: fx.dir, authToken: "tok", log: () => {}, exitProcess: () => {}, releaseListenSocket: () => {}, env: {} });
    server = serve({ fetch: daemon.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      const s = server as unknown as { address(): AddressInfo | null; once(ev: string, cb: () => void): void };
      if (s.address()) return resolve();
      s.once("listening", () => resolve());
    });
    const port = ((server as unknown as { address(): AddressInfo }).address()).port;

    const client = new DaemonClient(port, "s_cli", fx.dir, "tok");
    await client.register({ title: "t", expectedProjectRoot: fx.dir });
    await client.createArtifact({ id: "art_d", type: "decision", title: "Which?", content: { decisionId: "dec_d", question: "Which?", options: OPTS } });
    await client.recordDecisionRequest({ decisionId: "dec_d", artifactId: "art_d", context: "Which?", options: OPTS });

    const pub = withHash(createHttpRoutes(client, fx.dir, () => {}), fx.dir);
    const [ra, rb] = await Promise.all([
      pub.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "ra" })),
      pub.request("/api/decisions/dec_d", json({ optionId: "b", reasoning: "rb" })),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const winner = ra.status === 200 ? "a" : "b";
    expect(await (ra.status === 409 ? ra : rb).json()).toMatchObject({ code: "verdict_already_final", resolution: { optionId: winner } });

    // And the capability itself: a direct losing call is an outcome, not a throw.
    const outcome = await client.resolveDecisionAtomic("dec_d", winner === "a" ? "b" : "a");
    expect(outcome).toMatchObject({ kind: "conflict", resolution: { optionId: winner } });
  });
});

/**
 * #484 review — a resolve whose flush FAILED (503) is rolled back in memory, so
 * memory always matches disk: no delivery to the agent, no false "already
 * answered", no event. The retry after the lock is released is then an
 * ordinary first write — announced once, with ITS reasoning — and later
 * retries are no-ops. (Codex 6050934384's "announce the recovered write" is
 * subsumed: there is no unflushed winner left to recover.)
 */
describe("P2 — a failed (503) resolve leaves nothing behind; the retry is announced once", () => {
  const resolvedEvents = (events: Array<Record<string, unknown>>) => events.filter((e) => e.type === "decision_resolved");

  it("public: after 503 + release, getResolvedDecisions() is empty, the agent's resolved feed is empty, and a DIFFERENT pick succeeds (200, not a false 409)", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_rb"));
    seedDecision(store);
    await store.forceFlush();
    const events: Array<Record<string, unknown>> = [];
    const app = withHash(createHttpRoutes(store, fx.dir, (m) => events.push(m as Record<string, unknown>)), fx.dir);
    const lock = path.join(fx.dir, ".deeppairing", "sessions", "s_rb", ".flush.lock");
    fs.writeFileSync(lock, liveOwner());
    expect((await app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "first" }))).status).toBe(503);
    fs.unlinkSync(lock);
    await new Promise((r) => setTimeout(r, 300)); // any scheduled background flush has run

    expect(store.getResolvedDecisions().map((d) => d.decisionId)).not.toContain("dec_d");
    expect(store.getDecisionResponse("dec_d")).toBeNull();
    expect(onDiskResponse(fx.dir, "s_rb")).toBeNull();
    expect(store.getArtifacts().find((a) => a.id === "art_d")?.status).toBe("draft");
    expect(resolvedEvents(events)).toHaveLength(0);

    const other = await app.request("/api/decisions/dec_d", json({ optionId: "b", reasoning: "changed my mind" }));
    expect(other.status).toBe(200);
    expect(onDiskResponse(fx.dir, "s_rb")?.optionId).toBe("b");
    expect(resolvedEvents(events)).toHaveLength(1);
    expect(resolvedEvents(events)[0]).toMatchObject({ optionId: "b", reasoning: "changed my mind" });
  });

  it("internal: the agent's resolved feed (check_feedback's source) doesn't carry a 503'd answer", async () => {
    const sessions = new Map<string, FileStore>();
    const meta = new Map<string, SessionMeta>();
    const make = (sid: string) => { const s = fx.track(new FileStore(fx.dir, sid)); sessions.set(sid, s); return s; };
    const app = createDaemonRoutes(sessions, meta, make, () => {}, undefined, fx.dir);
    await app.request("/api/internal/sessions/s_rbi/register", json({}));
    const store = sessions.get("s_rbi")!;
    seedDecision(store);
    await store.forceFlush();
    const lock = path.join(fx.dir, ".deeppairing", "sessions", "s_rbi", ".flush.lock");
    fs.writeFileSync(lock, liveOwner());
    expect((await app.request("/api/internal/sessions/s_rbi/decisions/dec_d/resolve", json({ optionId: "a" }))).status).toBe(503);
    fs.unlinkSync(lock);
    const feed = await (await app.request("/api/internal/sessions/s_rbi/decisions/resolved")).json();
    expect(feed.decisions.map((d: { decisionId: string }) => d.decisionId)).not.toContain("dec_d");
  });

  it("public: 503 → release → same-choice retry is a fresh first write: ONE event (its reasoning); a later retry adds none", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_pubA"));
    seedDecision(store);
    await store.forceFlush();
    const events: Array<Record<string, unknown>> = [];
    const app = withHash(createHttpRoutes(store, fx.dir, (m) => events.push(m as Record<string, unknown>)), fx.dir);
    const lock = path.join(fx.dir, ".deeppairing", "sessions", "s_pubA", ".flush.lock");
    fs.writeFileSync(lock, liveOwner());
    expect((await app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "first" }))).status).toBe(503);
    expect(resolvedEvents(events)).toHaveLength(0);
    fs.unlinkSync(lock);

    expect((await app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "retry" }))).status).toBe(200);
    expect(resolvedEvents(events)).toHaveLength(1);
    expect(resolvedEvents(events)[0]).toMatchObject({ decisionId: "dec_d", optionId: "a", reasoning: "retry", artifactId: "art_d" });
    expect(onDiskResponse(fx.dir, "s_pubA")).toMatchObject({ optionId: "a", reasoning: "retry" });

    expect((await app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "again" }))).status).toBe(200);
    expect(resolvedEvents(events)).toHaveLength(1);
  });

  it("internal: the same — one event after the release, none on later retries", async () => {
    const sessions = new Map<string, FileStore>();
    const meta = new Map<string, SessionMeta>();
    const events: Array<Record<string, unknown>> = [];
    const make = (sid: string) => { const s = fx.track(new FileStore(fx.dir, sid)); sessions.set(sid, s); return s; };
    const app = createDaemonRoutes(sessions, meta, make, (_sid, e) => events.push(e as Record<string, unknown>), undefined, fx.dir);
    await app.request("/api/internal/sessions/s_intA/register", json({}));
    const store = sessions.get("s_intA")!;
    seedDecision(store);
    await store.forceFlush();
    const lock = path.join(fx.dir, ".deeppairing", "sessions", "s_intA", ".flush.lock");
    fs.writeFileSync(lock, liveOwner());
    const url = "/api/internal/sessions/s_intA/decisions/dec_d/resolve";
    expect((await app.request(url, json({ optionId: "a", reasoning: "first" }))).status).toBe(503);
    expect(resolvedEvents(events)).toHaveLength(0);
    fs.unlinkSync(lock);

    expect((await app.request(url, json({ optionId: "a", reasoning: "retry" }))).status).toBe(200);
    expect(resolvedEvents(events)).toHaveLength(1);
    expect(resolvedEvents(events)[0]).toMatchObject({ decisionId: "dec_d", optionId: "a", reasoning: "retry" });
    expect((await app.request(url, json({ optionId: "a" }))).status).toBe(200);
    expect(resolvedEvents(events)).toHaveLength(1);
  });

  it("an ordinary first-try success announces once, and a same-choice retry afterwards adds none (no duplicate)", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_pubC"));
    seedDecision(store);
    const events: Array<Record<string, unknown>> = [];
    const app = withHash(createHttpRoutes(store, fx.dir, (m) => events.push(m as Record<string, unknown>)), fx.dir);
    expect((await app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "first" }))).status).toBe(200);
    expect((await app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "again" }))).status).toBe(200);
    expect(resolvedEvents(events)).toHaveLength(1);
  });
});
