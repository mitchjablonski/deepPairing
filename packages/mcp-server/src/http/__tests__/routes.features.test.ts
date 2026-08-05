// #203 (H2) — GET /api/features: the Features view's read route. Mirrors the
// GET /api/decisions suite (routes.decisions.test.ts): empty shape, a populated
// scan, degrade-to-empty-not-500, and the X-Project-Hash gate.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { createRoutesTestContext, destroyRoutesTestContext, type RoutesTestContext } from "./routes.harness.js";

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
});
