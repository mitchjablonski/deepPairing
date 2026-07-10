// #138 — GET /api/decisions: the project-wide decisions view's read route.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { DecisionOption } from "@deeppairing/shared";
import { createHttpRoutes } from "../routes.js";
import { createRoutesTestContext, destroyRoutesTestContext, type RoutesTestContext } from "./routes.harness.js";

let ctx: RoutesTestContext;

const OPTS: DecisionOption[] = [
  { id: "o1", title: "Redis", description: "d", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
  { id: "o2", title: "In-proc", description: "d", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
];

beforeEach(() => {
  ctx = createRoutesTestContext();
});

afterEach(() => {
  destroyRoutesTestContext(ctx);
  vi.restoreAllMocks();
});

describe("GET /api/decisions", () => {
  it("returns the empty shape when no decisions exist", async () => {
    const res = await ctx.app.request("/api/decisions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decisions: [], failedSessions: [] });
  });

  it("returns a resolved decision with its chosen option and session", async () => {
    ctx.store.createArtifact({ id: "a1", type: "decision", title: "Which cache?", content: {} });
    ctx.store.recordDecisionRequest({ decisionId: "d1", artifactId: "a1", context: "Which cache?", options: OPTS });
    ctx.store.resolveDecision("d1", "o1", "lowest latency");
    ctx.store.forceFlush();

    const res = await ctx.app.request("/api/decisions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failedSessions).toEqual([]);
    expect(body.decisions).toHaveLength(1);
    const d = body.decisions[0];
    expect(d.decisionId).toBe("d1");
    expect(d.sessionId).toBe("test_session");
    expect(d.resolved).toBe(true);
    expect(d.chosenOptionTitle).toBe("Redis");
    expect(d.reasoning).toBe("lowest latency");
  });

  it("surfaces a corrupt session in failedSessions rather than truncating silently", async () => {
    // A healthy decision in the bound session.
    ctx.store.createArtifact({ id: "a1", type: "decision", title: "Good", content: {} });
    ctx.store.recordDecisionRequest({ decisionId: "d_good", artifactId: "a1", context: "Good", options: OPTS });
    ctx.store.resolveDecision("d_good", "o1");
    ctx.store.forceFlush();

    // A second session whose decisions.json can't be parsed.
    const badDir = path.join(ctx.tmpDir, ".deeppairing", "sessions", "s_bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "decisions.json"), "not json ]");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await ctx.app.request("/api/decisions");
    const body = await res.json();
    expect(body.decisions.map((d: { decisionId: string }) => d.decisionId)).toContain("d_good");
    expect(body.failedSessions).toEqual([{ sessionId: "s_bad", reason: expect.any(String) }]);
  });

  it("is X-Project-Hash gated — no hash → 403 (unwrapped app)", async () => {
    // The harness app auto-injects the hash; construct a raw one to prove the
    // gate fires before the handler (no unauthenticated read of the list).
    const raw = createHttpRoutes(ctx.store, ctx.tmpDir);
    const res = await raw.request("/api/decisions");
    expect(res.status).toBe(403);
  });
});
