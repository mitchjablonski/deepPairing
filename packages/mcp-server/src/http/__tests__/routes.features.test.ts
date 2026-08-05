// #203 (H2) — GET /api/features: the Features view's read route. Mirrors the
// GET /api/decisions suite (routes.decisions.test.ts): empty shape, a populated
// scan, degrade-to-empty-not-500, and the X-Project-Hash gate.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { createRoutesTestContext, destroyRoutesTestContext, withHash, type RoutesTestContext } from "./routes.harness.js";

let ctx: RoutesTestContext;

beforeEach(() => {
  ctx = createRoutesTestContext();
});
afterEach(() => {
  destroyRoutesTestContext(ctx);
  vi.restoreAllMocks();
});

describe("GET /api/features", () => {
  it("returns the empty shape when no artifacts exist", async () => {
    const res = await ctx.app.request("/api/features");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ groups: [], failedSessions: [] });
  });

  it("groups artifacts by mined title prefix, Ungrouped last", async () => {
    ctx.store.createArtifact({ id: "a1", type: "plan", title: "Milestone 6 — quota backfill", content: {} });
    ctx.store.createArtifact({ id: "a2", type: "plan", title: "M6 — quota UI", content: {} });
    ctx.store.createArtifact({ id: "a3", type: "plan", title: "Unrelated refactor", content: {} });
    ctx.store.forceFlush();

    const res = await ctx.app.request("/api/features");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failedSessions).toEqual([]);
    const m6 = body.groups.find((g: { id: string }) => g.id === "milestone-6");
    expect(m6.title).toBe("Milestone 6");
    expect(m6.artifactCount).toBe(2);
    expect(body.groups.at(-1).id).toBe("__ungrouped__");
  });

  it("degrades to the empty shape (200, not 500) if the project read throws", async () => {
    vi.spyOn(FileStore, "groupByFeature").mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await ctx.app.request("/api/features");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ groups: [], failedSessions: [] });
  });

  it("is X-Project-Hash gated — no hash → 403 (unwrapped app)", async () => {
    const raw = createHttpRoutes(ctx.store, ctx.tmpDir, () => {});
    const res = await raw.request("/api/features");
    expect(res.status).toBe(403);
  });

  it("applies persisted human overrides on read (rename wins over derived title)", async () => {
    ctx.store.createArtifact({ id: "a1", type: "plan", title: "Milestone 6 — x", content: {} });
    ctx.store.forceFlush();
    await ctx.app.request("/api/features/overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", groupKey: "milestone-6", title: "Quota backfill" }),
    });
    const res = await ctx.app.request("/api/features");
    const body = await res.json();
    expect(body.groups.find((g: { id: string }) => g.id === "milestone-6").title).toBe("Quota backfill");
  });
});

describe("POST /api/features/overrides", () => {
  it("rename returns the re-grouped result with the new title", async () => {
    ctx.store.createArtifact({ id: "a1", type: "plan", title: "Milestone 6 — x", content: {} });
    ctx.store.forceFlush();
    const res = await ctx.app.request("/api/features/overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", groupKey: "milestone-6", title: "Quota" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups.find((g: { id: string }) => g.id === "milestone-6").title).toBe("Quota");
  });

  it("assign moves an artifact into another feature (round-trip on the next GET)", async () => {
    ctx.store.createArtifact({ id: "a1", type: "plan", title: "loose end", content: {} });
    ctx.store.createArtifact({ id: "a2", type: "plan", title: "Milestone 9 — home", content: {} });
    ctx.store.forceFlush();
    const post = await ctx.app.request("/api/features/overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "assign", artifactId: "a1", groupKey: "milestone-9" }),
    });
    expect(post.status).toBe(200);
    const body = await (await ctx.app.request("/api/features")).json();
    const m9 = body.groups.find((g: { id: string }) => g.id === "milestone-9");
    expect(m9.artifactRefs.map((r: { artifactId: string }) => r.artifactId).sort()).toEqual(["a1", "a2"]);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await ctx.app.request("/api/features/overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("is X-Project-Hash gated — no hash → 403 (unwrapped app)", async () => {
    const raw = createHttpRoutes(ctx.store, ctx.tmpDir, () => {});
    const res = await raw.request("/api/features/overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", groupKey: "milestone-6", title: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("is bearer-gated when the daemon has a token — no bearer → 401", async () => {
    // Mirrors /api/comments' SP1 mutation gate: a token-bearing daemon rejects
    // an unauthenticated write (hash alone is insufficient).
    const authed = withHash(
      createHttpRoutes(ctx.store, ctx.tmpDir, () => {}, undefined, "secret-token"),
      ctx.tmpDir,
    );
    const noBearer = await authed.request("/api/features/overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", groupKey: "milestone-6", title: "x" }),
    });
    expect(noBearer.status).toBe(401);
    const withBearer = await authed.request("/api/features/overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify({ action: "rename", groupKey: "milestone-6", title: "x" }),
    });
    expect(withBearer.status).toBe(200);
  });
});
