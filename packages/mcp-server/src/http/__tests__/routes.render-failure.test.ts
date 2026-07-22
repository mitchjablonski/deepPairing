/**
 * #176 (Option A) — POST /api/render-failures. The browser reports a Mermaid
 * diagram that genuinely failed to render so the agent learns via check_feedback.
 * Pins the PUBLIC route contract: happy path persists ids + error + title (never
 * source), an unknown artifact fails loudly (F6), and malformed bodies 400.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoutesTestContext, destroyRoutesTestContext } from "./routes.harness.js";
import type { RoutesTestContext } from "./routes.harness.js";

let ctx: RoutesTestContext;

beforeEach(() => {
  ctx = createRoutesTestContext();
  ctx.store.createArtifact({ id: "plan_1", type: "plan", title: "Plan", content: { steps: [] } });
});

afterEach(() => destroyRoutesTestContext(ctx));

const post = (body: unknown) =>
  ctx.app.request("/api/render-failures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/render-failures", () => {
  it("records a failure for an owned artifact (ids + title + error, source stripped)", async () => {
    const res = await post({
      artifactId: "plan_1",
      visualId: "vis_a",
      error: "Parse error on line 2",
      title: "Auth flow",
      // A drifted client that tried to smuggle source is ignored — the schema
      // has no `source` field, so parse strips it and nothing is persisted.
      source: "graph TD; A-->B",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "recorded", artifactId: "plan_1", visualId: "vis_a" });

    const pending = ctx.store.getUnacknowledgedRenderFailures();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      artifactId: "plan_1",
      visualId: "vis_a",
      title: "Auth flow",
      error: "Parse error on line 2",
    });
    expect(JSON.stringify(pending[0])).not.toContain("graph TD");
  });

  it("fails loudly (404) for an artifact this session does not own", async () => {
    const res = await post({ artifactId: "ghost", visualId: "vis_a", error: "boom" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("artifact_not_in_session");
    expect(ctx.store.getUnacknowledgedRenderFailures()).toHaveLength(0);
  });

  it("400s a body missing required fields", async () => {
    const res = await post({ artifactId: "plan_1" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_error");
  });
});
