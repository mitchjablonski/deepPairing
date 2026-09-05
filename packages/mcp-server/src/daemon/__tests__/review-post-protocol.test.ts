import { afterEach, beforeEach, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import fs from "node:fs";
import { createDaemonRoutes, type SessionMeta } from "../routes.js";
import { DaemonClient } from "../client.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { executeDurableReviewPost } from "../../github/durable-review-post.js";
import { reviewPostDigest } from "../../store/review-post-journal.js";
import { projectHashOf } from "../../project-root.js";
import { projectHashGate } from "../../http/guards.js";

const token = "review-post-test-token";
const target = "https://github.com/acme/widget/pull/12";
const payload = { body: "Reviewed", event: "COMMENT" as const, comments: [] };
const identity = { target, event: payload.event, payloadDigest: reviewPostDigest(payload), authorizationDigest: "b".repeat(64) };
const result = { id: 7, htmlUrl: `${target}#pullrequestreview-7`, state: "COMMENTED" as const };
let fx: GlobalStoreFixture;
let local: FileStore;
let client: DaemonClient;
let server: ServerType;
let app: ReturnType<typeof createDaemonRoutes>;
let broadcasts: unknown[];

beforeEach(async () => {
  fx = withGlobalStore("dp-review-post-http-");
  const sessions = new Map<string, FileStore>();
  const create = (sid: string) => {
    const store = fx.track(new FileStore(fx.dir, sid));
    sessions.set(sid, store);
    return store;
  };
  local = create("s");
  broadcasts = [];
  const internal = createDaemonRoutes(sessions, new Map<string, SessionMeta>(), create,
    (_sid, event) => broadcasts.push(event), undefined, fx.dir, token);
  // Production mounts the project-hash gate on the enclosing daemon app.
  app = new Hono();
  app.use("/api/internal/*", projectHashGate(projectHashOf(fx.dir)));
  app.route("/", internal);
  const port = await new Promise<number>(resolve => {
    server = serve({ fetch: app.fetch, port: 0 }, info => resolve(info.port));
  });
  client = new DaemonClient(port, "s", fx.dir, token);
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  fx.dispose();
});

it("HTTP posting reads external revocation while UI hydration remains cached", async () => {
  local.createArtifact({ id: "a", type: "research", title: "Review", content: {} });
  local.updateArtifactStatus("a", "approved", "ui_approve_button");
  local.forceFlush();
  const external = fx.track(new FileStore(fx.dir, "s"));
  external.updateArtifactStatus("a", "obsolete", "agent_obsolete");
  external.forceFlush();
  expect((await client.getFullState()).artifacts[0].status).toBe("approved");
  expect((await client.getReviewPostState()).artifacts[0].status).toBe("obsolete");
  expect(broadcasts).toEqual([]);
});

it("posting snapshot route requires bearer, project, and an existing session", async () => {
  const url = "/api/internal/sessions/s/review-post-state";
  const headers = { Authorization: `Bearer ${token}`, "X-Project-Hash": projectHashOf(fx.dir) };
  expect((await app.request(url, { headers: { "X-Project-Hash": projectHashOf(fx.dir) } })).status).toBe(401);
  expect((await app.request(url, { headers: { ...headers, "X-Project-Hash": "wrong" } })).status).toBe(403);
  expect((await app.request("/api/internal/sessions/absent/review-post-state", { headers })).status).toBe(404);
});

it("CLI FileStore and real HTTP DaemonClient share one durable reservation", async () => {
  let sends = 0;
  const outcomes = await Promise.allSettled([local.reviewPosts, client.reviewPosts].map(store =>
    executeDurableReviewPost({ store, identity, payload, repost: false,
      reauthorize: () => identity, send: async () => { sends++; return result; } })));
  expect(sends).toBe(1);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
  expect(local.reviewPosts.list()).toMatchObject([{ state: "succeeded", result }]);
  expect(broadcasts).toEqual([]);
});

it("HTTP retries cannot authorize a second send or bypass uncertainty with repost", async () => {
  const lease = await client.reviewPosts.reserve(identity, false);
  await client.reviewPosts.markSending(lease, identity);
  await expect(client.reviewPosts.markSending(lease, identity)).rejects.toMatchObject({ status: 409, code: "review_post_conflict" });
  await client.reviewPosts.markUnknown(lease);
  await expect(client.reviewPosts.reserve(identity, true)).rejects.toMatchObject({ status: 409 });
  expect(local.reviewPosts.list()[0].state).toBe("unknown");
});

it("corrupt durable history refuses over HTTP without modifying it or broadcasting", async () => {
  fs.writeFileSync(local.reviewPosts.journalPath, "{broken");
  await expect(client.reviewPosts.reserve(identity, true)).rejects.toMatchObject({ status: 409, code: "review_post_conflict" });
  expect(fs.readFileSync(local.reviewPosts.journalPath, "utf8")).toBe("{broken");
  expect(broadcasts).toEqual([]);
});

it("bearer and project gates precede validation; malformed transitions never persist", async () => {
  const url = "/api/internal/sessions/s/review-post-operations";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Project-Hash": projectHashOf(fx.dir) };
  expect((await app.request(url, { method: "POST", headers: { "X-Project-Hash": projectHashOf(fx.dir) }, body: "null" })).status).toBe(401);
  expect((await app.request(url, { method: "POST", headers: { ...headers, "X-Project-Hash": "wrong" }, body: "null" })).status).toBe(403);
  for (const body of ["null", "{broken", JSON.stringify({ action: "sending", lease: { operationId: "bad", token: "bad" }, identity }),
    JSON.stringify({ action: "reserve", identity, repost: true, extra: true })]) {
    expect((await app.request(url, { method: "POST", headers, body })).status).toBe(400);
  }
  expect(local.reviewPosts.list()).toEqual([]);
  expect(broadcasts).toEqual([]);
});
