import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { collectUnansweredQuestions } from "@deeppairing/shared";
import { createDaemonRoutes, type SessionMeta } from "../routes.js";
import { DaemonClient } from "../client.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { projectHashOf } from "../../project-root.js";
import { projectHashGate } from "../../http/guards.js";

const token = "retirement-test-token";
const input = { artifactId: "a", expectedVersion: 1, expectedStatus: "draft" as const,
  door: "revise" as const, mode: "retract" as const, reason: "Premise invalid" };
let fx: GlobalStoreFixture;
let local: FileStore;
let client: DaemonClient;
let server: ServerType;
let app: Hono;
let broadcasts: unknown[];
const artifact = () => local.getArtifacts().find(a => a.id === "a")!;
const collection = (name: string) => path.join(fx.dir, ".deeppairing", "sessions", "s", name);
const mutations = () => broadcasts.filter(event => (event as { type: string }).type !== "agent_activity");
const post = (url: string, body: string) => app.request(url, { method: "POST",
  headers: { Authorization: `Bearer ${token}`, "X-Project-Hash": projectHashOf(fx.dir), "Content-Type": "application/json" }, body });

beforeEach(async () => {
  fx = withGlobalStore("dp-retirement-http-");
  const sessions = new Map<string, FileStore>();
  const create = (sid: string) => {
    const store = fx.track(new FileStore(fx.dir, sid));
    sessions.set(sid, store);
    return store;
  };
  local = create("s");
  local.createArtifact({ id: "a", type: "research", title: "Finding", content: { summary: "Premise" } });
  local.forceFlush();
  broadcasts = [];
  app = new Hono();
  app.use("/api/internal/*", projectHashGate(projectHashOf(fx.dir)));
  app.route("/", createDaemonRoutes(sessions, new Map<string, SessionMeta>(), create,
    (_sid, event) => broadcasts.push(event), undefined, fx.dir, token));
  const port = await new Promise<number>(resolve => {
    server = serve({ fetch: app.fetch, port: 0 }, info => resolve(info.port));
  });
  client = new DaemonClient(port, "s", fx.dir, token);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  fx.dispose();
});

it("uses one authoritative operation and preserves delivered unanswered feedback", async () => {
  local.addComment({ id: "q", artifactId: "a", content: "Why?", author: "human", intent: "question" });
  local.acknowledgeComments(["q"]);
  local.forceFlush();
  const comments = fs.readFileSync(collection("comments.json"), "utf8");
  const call = vi.spyOn(local, "retireArtifact");
  expect(await client.retireArtifact(input)).toMatchObject({ kind: "blocked_feedback", unansweredQuestions: 1 });
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith(input);
  expect(artifact().status).toBe("draft");
  expect(fs.readFileSync(collection("comments.json"), "utf8")).toBe(comments);
  expect(mutations()).toEqual([]);
});

it("publishes success only after durable retirement and replays without new history", async () => {
  expect((await client.retireArtifact(input)).kind).toBe("committed");
  const disk = fx.track(new FileStore(fx.dir, "s"));
  expect(disk.getArtifacts()[0].status).toBe("retracted");
  const history = structuredClone(artifact().statusHistory);
  const markers = structuredClone(local.getCommentsForArtifact("a"));
  expect(mutations().some(event => (event as { type: string }).type === "artifact_updated")).toBe(true);
  expect((await client.retireArtifact(input)).kind).toBe("already_retired");
  expect(artifact().statusHistory).toEqual(history);
  expect(local.getCommentsForArtifact("a")).toEqual(markers);
});

it("disarms approved external research while its question remains open", async () => {
  local.createArtifact({ id: "external", type: "changeset", title: "PR", content: { files: [], reviewIntent: "external" } });
  local.updateArtifactStatus("a", "approved", "ui_approve_button");
  local.addComment({ id: "q", artifactId: "a", content: "Still owed", author: "human", intent: "question" });
  const before = structuredClone(local.getComment("q"));
  expect(await client.retireArtifact({ ...input, expectedStatus: "approved" })).toMatchObject({ kind: "committed", disarmed: true });
  expect(local.getComment("q")).toEqual(before);
  const comments = local.getCommentsForArtifact("a");
  expect(collectUnansweredQuestions(comments).map(q => q.question.id)).toEqual(["q"]);
  expect(comments.find(c => c.author === "agent")?.parentCommentId).toBeFalsy();
});

it("rejects invalid bodies and path identity mismatches before calling the operation", async () => {
  const call = vi.spyOn(local, "retireArtifact");
  const url = "/api/internal/sessions/s/artifacts/a/retire";
  for (const body of ["null", "{broken", "[]", JSON.stringify({ ...input, expectedVersion: 0 }),
    JSON.stringify({ ...input, reason: " " }), JSON.stringify({ ...input, door: "human" }),
    JSON.stringify({ ...input, mode: "supersede" }), JSON.stringify({ ...input, artifactId: "different" }),
    JSON.stringify({ ...input, bypass: true })]) {
    expect((await post(url, body)).status).toBe(400);
  }
  expect(call).not.toHaveBeenCalled();
  expect(artifact().status).toBe("draft");
  expect(mutations()).toEqual([]);
});

it("keeps retirement session scoped and returns typed stale predicates", async () => {
  expect((await post("/api/internal/sessions/absent/artifacts/a/retire", JSON.stringify(input))).status).toBe(404);
  expect(await client.retireArtifact({ ...input, expectedVersion: 2 })).toMatchObject({ kind: "stale" });
  expect(await client.retireArtifact({ ...input, expectedStatus: "reviewing" })).toMatchObject({ kind: "stale" });
  expect(artifact().status).toBe("draft");
  expect(mutations()).toEqual([]);
});

for (const reason of ["agent_retract", "agent_obsolete", "agent_withdraw"] as const) {
  it(`generic status rejects ${reason} without any lifecycle, feedback, flush or broadcast side effect`, async () => {
    local.addComment({ id: "h", artifactId: "a", content: "Human input", author: "human" });
    local.forceFlush();
    const before = { artifacts: fs.readFileSync(collection("artifacts.json"), "utf8"), comments: fs.readFileSync(collection("comments.json"), "utf8") };
    const update = vi.spyOn(local, "updateArtifactStatus");
    const flush = vi.spyOn(local, "forceFlush");
    await expect(client.updateArtifactStatus("a", reason === "agent_obsolete" ? "obsolete" : "retracted", reason))
      .rejects.toMatchObject({ status: 400, code: "validation_error" });
    expect(update).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(artifact().status).toBe("draft");
    expect(fs.readFileSync(collection("artifacts.json"), "utf8")).toBe(before.artifacts);
    expect(fs.readFileSync(collection("comments.json"), "utf8")).toBe(before.comments);
    expect(mutations()).toEqual([]);
  });
}

it.each([
  ["ui_dismiss_obsolete", "obsolete"], ["agent_supersede", "superseded"],
] as const)("preserves legitimate generic status caller %s", async (reason, status) => {
  await client.updateArtifactStatus("a", status, reason);
  expect(artifact().status).toBe(status);
  expect(mutations()).toContainEqual(expect.objectContaining({ type: "artifact_updated", artifactId: "a", status, reason }));
});

it("returns persistence uncertainty without success broadcasts and retries without duplicate history", async () => {
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === collection("comments.json")) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    return rename(from, to);
  });
  expect(await client.retireArtifact(input)).toMatchObject({ kind: "persist_uncertain" });
  expect(artifact().status).toBe("retracted");
  const history = structuredClone(artifact().statusHistory);
  expect(mutations()).toEqual([]);
  spy.mockRestore();
  expect((await client.retireArtifact(input)).kind).toBe("already_retired");
  expect(artifact().statusHistory).toEqual(history);
  expect(local.getCommentsForArtifact("a").filter(c => c.author === "agent")).toHaveLength(1);
});
