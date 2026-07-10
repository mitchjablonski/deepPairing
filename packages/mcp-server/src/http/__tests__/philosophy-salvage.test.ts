import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRoutesTestContext, destroyRoutesTestContext, type RoutesTestContext } from "./routes.harness.js";

/**
 * H1-5(b)+(c) — a hand-edited/hostile philosophy ledger (one entry whose
 * `instances` isn't an array) used to make deriveStance/query `.filter` throw,
 * 500ing EVERY taste/ledger route. Per-entry salvage on read + a try/catch at
 * the query() call sites means these routes now degrade to 200 with the good
 * entries instead. Drives the real HTTP routes through the shared harness.
 */
let ctx: RoutesTestContext;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ctx = createRoutesTestContext();
  // The harness points the global ledger at <tmpDir>/philosophy.json. Plant a
  // ledger with one sound entry and one whose `instances` is a scalar.
  const good = {
    key: "redis", concept: "redis",
    instances: [{ project: "repo-a", sessionId: "s1", verdict: "rejected", at: "2026-01-02T00:00:00.000Z" }],
    firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-02T00:00:00.000Z",
  };
  const bad = { key: "kafka", concept: "kafka", instances: "not-an-array", firstSeenAt: "x", lastSeenAt: "y" };
  fs.writeFileSync(
    path.join(ctx.tmpDir, "philosophy.json"),
    JSON.stringify({ version: 1, concepts: { redis: good, kafka: bad } }),
  );
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  destroyRoutesTestContext(ctx);
});

describe("H1-5 — taste/ledger routes degrade instead of 500 on a malformed ledger", () => {
  it("GET /api/philosophy returns 200 with the salvaged entry (not a 500)", async () => {
    const res = await ctx.app.request("/api/philosophy");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.map((e: { concept: string }) => e.concept)).toEqual(["redis"]);
  });

  it("GET /api/philosophy/digest returns 200", async () => {
    const res = await ctx.app.request("/api/philosophy/digest");
    expect(res.status).toBe(200);
  });

  it("GET /api/ledger/digest returns 200", async () => {
    const res = await ctx.app.request("/api/ledger/digest");
    expect(res.status).toBe(200);
  });
});
