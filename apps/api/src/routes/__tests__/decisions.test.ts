import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createDecisionRoutes } from "../decisions.js";
import { DecisionManager } from "../../services/decision-manager.js";

function createTestApp() {
  const decisionManager = new DecisionManager();
  const app = new Hono();
  app.route("/", createDecisionRoutes(decisionManager));
  return { app, decisionManager };
}

describe("POST /api/sessions/:sessionId/decisions/:decisionId", () => {
  it("resolves a pending decision", async () => {
    const { app, decisionManager } = createTestApp();

    // Create a pending decision
    const promise = decisionManager.createPendingDecision("dec_001", [
      "opt_a",
      "opt_b",
    ]);

    // Resolve via HTTP
    const res = await app.request(
      "/api/sessions/sess_1/decisions/dec_001",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "opt_a", reasoning: "Looks good" }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("resolved");

    // The promise should resolve with the selection
    const result = await promise;
    expect(result.optionId).toBe("opt_a");
    expect(result.reasoning).toBe("Looks good");
  });

  it("returns 404 for non-existent decision", async () => {
    const { app } = createTestApp();

    const res = await app.request(
      "/api/sessions/sess_1/decisions/nonexistent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "opt_a" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid option id", async () => {
    const { app, decisionManager } = createTestApp();

    decisionManager.createPendingDecision("dec_002", ["opt_a", "opt_b"]);

    const res = await app.request(
      "/api/sessions/sess_1/decisions/dec_002",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "opt_c" }),
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid option id");
  });

  it("returns 400 for missing optionId", async () => {
    const { app, decisionManager } = createTestApp();

    decisionManager.createPendingDecision("dec_003", ["opt_a"]);

    const res = await app.request(
      "/api/sessions/sess_1/decisions/dec_003",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/:sessionId/decisions/pending", () => {
  it("returns pending decision ids", async () => {
    const { app, decisionManager } = createTestApp();

    decisionManager.createPendingDecision("dec_a", ["opt_1"]);
    decisionManager.createPendingDecision("dec_b", ["opt_1"]);

    const res = await app.request("/api/sessions/sess_1/decisions/pending");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pending).toContain("dec_a");
    expect(body.pending).toContain("dec_b");
  });

  it("returns empty array when no pending decisions", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/sessions/sess_1/decisions/pending");
    const body = await res.json();
    expect(body.pending).toEqual([]);
  });
});
