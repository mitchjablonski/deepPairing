/**
 * #680 slice 3 — the DaemonClient proxies for the page file watch, over real
 * HTTP to the real internal routes: acknowledging notices by ref, and the
 * supersede compare-and-swap's 409 `parent_superseded` (which revise_artifact
 * reads in daemon mode).
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { readFileWatch } from "@deeppairing/shared";
import { createDaemonRoutes, type SessionMeta } from "../routes.js";
import { DaemonClient } from "../client.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { projectHashOf } from "../../project-root.js";
import { projectHashGate } from "../../http/guards.js";

const token = "page-watch-client-token";
let fx: GlobalStoreFixture;
let local: FileStore;
let client: DaemonClient;
let server: ServerType;

beforeEach(async () => {
  fx = withGlobalStore("dp-pagewatch-client-");
  const sessions = new Map<string, FileStore>();
  const create = (sid: string) => {
    const store = fx.track(new FileStore(fx.dir, sid));
    sessions.set(sid, store);
    return store;
  };
  local = create("s");
  const app = new Hono();
  app.use("/api/internal/*", projectHashGate(projectHashOf(fx.dir)));
  app.route("/", createDaemonRoutes(sessions, new Map<string, SessionMeta>(), create, () => {}, undefined, fx.dir, token));
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  client = new DaemonClient(port, "s", fx.dir, token);
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  fx.dispose();
});

const page = (id: string, extra: Record<string, unknown> = {}) =>
  local.createArtifact({ id, type: "page", title: "P", content: { title: "P", html: "<p>x</p>", sourcePath: "docs/p.html" }, ...extra });

it("acknowledges exactly the referenced notice through the proxy", async () => {
  page("art_a");
  local.setPageFileWatch("art_a", "recorded", { at: "2026-11-21T00:00:00.000Z", sourcePath: "docs/p.html", fromArtifactId: "art_0", fromVersion: 1, carriedCount: 0, orphaned: [] });
  local.setPageFileWatch("art_a", "refused", { at: "2026-11-21T00:00:09.000Z", sourcePath: "docs/p.html", cause: "gate", message: "m", digest: "d" });
  // A ref naming the recorded notice only: the refusal stays undelivered.
  await client.acknowledgeFileWatchNotices([{ artifactId: "art_a", recordedAt: "2026-11-21T00:00:00.000Z" }]);
  const fw = readFileWatch(local.getArtifacts()[0]!.fileWatch);
  expect(fw.recorded?.delivered).toBe(true);
  expect(fw.refused?.delivered).toBeUndefined();
});

it("surfaces the supersede compare-and-swap as a 409 parent_superseded carrying the winner", async () => {
  page("art_v1");
  page("art_v2", { parentId: "art_v1", version: 2 });
  local.setPageFileWatch("art_v2", "recorded", { at: "2026-11-21T00:00:00.000Z", sourcePath: "docs/p.html", fromArtifactId: "art_v1", fromVersion: 1, carriedCount: 0, orphaned: [] });
  const err = await client
    .createArtifact({ id: "art_late", type: "page", title: "P", content: { title: "P", html: "<p>y</p>" }, parentId: "art_v1", version: 2, requireUnsupersededParent: true })
    .then(() => null, (e: unknown) => e);
  expect(err).toMatchObject({ status: 409, code: "parent_superseded", body: { successorId: "art_v2", successorVersion: 2, successorFromFile: true } });
  expect(local.getArtifacts().some((a) => a.id === "art_late")).toBe(false);
});
