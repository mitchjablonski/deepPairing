/**
 * Integration tests for the daemon architecture.
 * Tests: daemon-routes (via Hono request), DaemonClient (via real HTTP server),
 * and the full session lifecycle.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createDaemonRoutes } from "../daemon-routes.js";
import { DaemonClient } from "../daemon-client.js";
import { FileStore } from "../store/file-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Test helpers ---

let tmpDir: string;
let sessions: Map<string, FileStore>;
let broadcasts: Array<{ sessionId: string; event: any }>;
let app: ReturnType<typeof createDaemonRoutes>;

function createTestSession(sessionId: string): FileStore {
  const store = new FileStore(tmpDir, sessionId);
  sessions.set(sessionId, store);
  return store;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-daemon-test-"));
  sessions = new Map();
  broadcasts = [];
  app = createDaemonRoutes(
    sessions,
    createTestSession,
    (sessionId, event) => broadcasts.push({ sessionId, event }),
  );
});

afterAll(() => {
  // Clean up any leftover temp dirs
});

// --- Daemon Routes (direct Hono request) ---

describe("Daemon Routes", () => {
  const SESSION = "test_session_1";

  it("registers a session and creates a FileStore", async () => {
    const res = await app.request(`/api/internal/sessions/${SESSION}/register`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("registered");
    expect(body.sessionId).toBe(SESSION);
    expect(sessions.has(SESSION)).toBe(true);
  });

  it("creates an artifact via the internal API", async () => {
    // Register first
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });

    const res = await app.request(`/api/internal/sessions/${SESSION}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "art_test_1",
        type: "research",
        title: "Test Finding",
        content: { summary: "test" },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.artifact.id).toBe("art_test_1");
    expect(body.artifact.type).toBe("research");

    // Verify broadcast was called
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].sessionId).toBe(SESSION);
    expect(broadcasts[0].event.type).toBe("artifact_created");
  });

  it("returns artifacts for a session", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });
    await app.request(`/api/internal/sessions/${SESSION}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "a1", type: "research", title: "T", content: {} }),
    });

    const res = await app.request(`/api/internal/sessions/${SESSION}/artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.artifacts).toHaveLength(1);
  });

  it("adds a comment and broadcasts", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });

    const res = await app.request(`/api/internal/sessions/${SESSION}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "cmt_1", artifactId: "art_1", content: "Nice", author: "human" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comment.content).toBe("Nice");
    expect(broadcasts.some((b) => b.event.type === "comment_added")).toBe(true);
  });

  it("records and resolves a decision", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });

    await app.request(`/api/internal/sessions/${SESSION}/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decisionId: "dec_1",
        artifactId: "art_1",
        context: "Which pattern?",
        options: [{ id: "a", title: "A" }],
      }),
    });

    // Check pending
    const pendingRes = await app.request(`/api/internal/sessions/${SESSION}/decisions/pending`);
    const pending = await pendingRes.json();
    expect(pending.decisions).toHaveLength(1);

    // Resolve
    await app.request(`/api/internal/sessions/${SESSION}/decisions/dec_1/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "a", reasoning: "Best choice" }),
    });

    // Check resolved
    const resolvedRes = await app.request(`/api/internal/sessions/${SESSION}/decisions/resolved`);
    const resolved = await resolvedRes.json();
    expect(resolved.decisions).toHaveLength(1);
    expect(resolved.decisions[0].response.optionId).toBe("a");
  });

  it("records and resolves a plan review", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });

    await app.request(`/api/internal/sessions/${SESSION}/plan-reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: "art_plan_1" }),
    });

    const pendingRes = await app.request(`/api/internal/sessions/${SESSION}/plan-reviews/pending`);
    const pending = await pendingRes.json();
    expect(pending.reviews).toHaveLength(1);

    await app.request(`/api/internal/sessions/${SESSION}/plan-reviews/art_plan_1/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "approved", feedback: "LGTM" }),
    });

    const verdictRes = await app.request(`/api/internal/sessions/${SESSION}/plan-reviews/art_plan_1/verdict`);
    const verdict = await verdictRes.json();
    expect(verdict.verdict).toBe("approved");
    expect(verdict.feedback).toBe("LGTM");
  });

  it("returns session state", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });
    await app.request(`/api/internal/sessions/${SESSION}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "a1", type: "research", title: "T", content: {} }),
    });

    const res = await app.request(`/api/internal/sessions/${SESSION}/state`);
    const state = await res.json();
    expect(state.sessionId).toBe(SESSION);
    expect(state.artifacts).toHaveLength(1);
  });

  it("manages autonomy level", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });

    await app.request(`/api/internal/sessions/${SESSION}/autonomy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "balanced" }),
    });

    const res = await app.request(`/api/internal/sessions/${SESSION}/autonomy`);
    const body = await res.json();
    expect(body.level).toBe("balanced");
  });

  it("manages session memory", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });

    await app.request(`/api/internal/sessions/${SESSION}/memory/approved`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Service pattern" }),
    });
    await app.request(`/api/internal/sessions/${SESSION}/memory/rejected`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Inline refactor" }),
    });

    const res = await app.request(`/api/internal/sessions/${SESSION}/memory`);
    const memory = await res.json();
    expect(memory.approvedPatterns).toContain("Service pattern");
    expect(memory.rejectedApproaches).toContain("Inline refactor");
  });

  it("lists active sessions", async () => {
    await app.request(`/api/internal/sessions/sess_1/register`, { method: "POST" });
    await app.request(`/api/internal/sessions/sess_2/register`, { method: "POST" });

    const res = await app.request("/api/internal/sessions");
    const body = await res.json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.map((s: any) => s.sessionId)).toContain("sess_1");
    expect(body.sessions.map((s: any) => s.sessionId)).toContain("sess_2");
  });

  it("unregisters a session", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });
    await app.request(`/api/internal/sessions/${SESSION}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "a1", type: "research", title: "T", content: {} }),
    });

    const res = await app.request(`/api/internal/sessions/${SESSION}/unregister`, { method: "POST" });
    expect(res.status).toBe(200);

    // Session data should still be accessible (persisted)
    const stateRes = await app.request(`/api/internal/sessions/${SESSION}/state`);
    const state = await stateRes.json();
    expect(state.artifacts).toHaveLength(1);
  });

  it("acknowledges comments", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });

    // Add a comment
    const addRes = await app.request(`/api/internal/sessions/${SESSION}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "cmt_1", artifactId: "art_1", content: "Test", author: "human" }),
    });
    const { comment } = await addRes.json();

    // Check unacknowledged
    const unackRes = await app.request(`/api/internal/sessions/${SESSION}/comments/unacknowledged`);
    const unack = await unackRes.json();
    expect(unack.comments).toHaveLength(1);

    // Acknowledge
    await app.request(`/api/internal/sessions/${SESSION}/comments/acknowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [comment.id] }),
    });

    // Verify acknowledged
    const unackRes2 = await app.request(`/api/internal/sessions/${SESSION}/comments/unacknowledged`);
    const unack2 = await unackRes2.json();
    expect(unack2.comments).toHaveLength(0);
  });
});

// --- DaemonClient (via real HTTP server) ---

describe("DaemonClient", () => {
  let server: any;
  let client: DaemonClient;
  const TEST_PORT = 13847; // Unusual port to avoid conflicts
  const SESSION = "client_test_session";

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-client-test-"));
    sessions = new Map();
    broadcasts = [];
    const routes = createDaemonRoutes(
      sessions,
      (id) => { const s = new FileStore(tmpDir, id); sessions.set(id, s); return s; },
      (sid, event) => broadcasts.push({ sessionId: sid, event }),
    );

    server = serve({ fetch: routes.fetch, port: TEST_PORT });
    client = new DaemonClient(TEST_PORT, SESSION);
    await client.register();
  });

  afterAll(() => {
    server?.close?.();
    // Force flush all stores before cleanup
    for (const store of sessions.values()) store.forceFlush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates and retrieves artifacts", async () => {
    const artifact = await client.createArtifact({
      id: "art_c1",
      type: "research",
      title: "Client Test Finding",
      content: { summary: "hello" },
    });
    expect(artifact.id).toBe("art_c1");
    expect(artifact.title).toBe("Client Test Finding");

    const artifacts = await client.getArtifacts();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe("art_c1");
  });

  it("adds and retrieves comments", async () => {
    const comment = await client.addComment({
      id: "cmt_c1",
      artifactId: "art_c1",
      content: "Great work",
      author: "human",
    });
    expect(comment.content).toBe("Great work");

    const unack = await client.getUnacknowledgedComments();
    expect(unack.length).toBeGreaterThanOrEqual(1);

    await client.acknowledgeComments([comment.id]);
    const unack2 = await client.getUnacknowledgedComments();
    expect(unack2.length).toBe(0);
  });

  it("records and resolves decisions", async () => {
    await client.recordDecisionRequest({
      decisionId: "dec_c1",
      artifactId: "art_c1",
      context: "Test decision",
      options: [{ id: "a", title: "Option A" }],
    });

    const pending = await client.getPendingDecisions();
    expect(pending).toHaveLength(1);

    await client.resolveDecision("dec_c1", "a", "Best option");

    const response = await client.getDecisionResponse("dec_c1");
    expect(response?.optionId).toBe("a");

    const resolved = await client.getResolvedDecisions();
    expect(resolved).toHaveLength(1);

    await client.acknowledgeDecisions(["dec_c1"]);
    const resolved2 = await client.getResolvedDecisions();
    expect(resolved2).toHaveLength(0);
  });

  it("records and resolves plan reviews", async () => {
    await client.recordPlanReview("art_plan_c1");

    const pending = await client.getPendingPlanReviews();
    expect(pending).toHaveLength(1);

    await client.resolvePlanReview("art_plan_c1", "approved", "Ship it");

    const verdict = await client.getPlanReviewVerdict("art_plan_c1");
    expect(verdict?.verdict).toBe("approved");
    expect(verdict?.feedback).toBe("Ship it");
  });

  it("manages autonomy level", async () => {
    await client.setAutonomyLevel("autonomous");
    const level = await client.getAutonomyLevel();
    expect(level).toBe("autonomous");
  });

  it("manages session memory", async () => {
    await client.recordApprovedPattern("Service layer");
    await client.recordRejectedApproach("God object");

    const memory = await client.getSessionMemory();
    expect(memory.approvedPatterns).toContain("Service layer");
    expect(memory.rejectedApproaches).toContain("God object");
  });

  it("returns full state", async () => {
    const state = await client.getFullState();
    expect(state.sessionId).toBe(SESSION);
    expect(state.artifacts.length).toBeGreaterThanOrEqual(1);
  });

  it("returns session ID without HTTP call", () => {
    expect(client.getSessionId()).toBe(SESSION);
  });

  it("returns engagement metrics", async () => {
    const metrics = await client.getEngagementMetrics();
    expect(metrics).toHaveProperty("avgReviewLatencyMs");
    expect(metrics).toHaveProperty("commentDensity");
    expect(metrics).toHaveProperty("approvalRate");
  });

  it("renames artifacts", async () => {
    await client.renameArtifact("art_c1", "Renamed Finding");
    const artifacts = await client.getArtifacts();
    const renamed = artifacts.find((a) => a.id === "art_c1");
    expect(renamed?.title).toBe("Renamed Finding");
  });

  it("updates artifact status", async () => {
    await client.updateArtifactStatus("art_c1", "approved");
    const artifacts = await client.getArtifacts();
    const updated = artifacts.find((a) => a.id === "art_c1");
    expect(updated?.status).toBe("approved");
  });
});
