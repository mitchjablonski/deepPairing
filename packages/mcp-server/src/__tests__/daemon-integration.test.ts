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
import { setGlobalStoreForTests } from "../store/global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Test helpers ---

import type { SessionMeta } from "../daemon-routes.js";

let tmpDir: string;
let sessions: Map<string, FileStore>;
let sessionMeta: Map<string, SessionMeta>;
let broadcasts: Array<{ sessionId: string; event: any }>;
let app: ReturnType<typeof createDaemonRoutes>;

function createTestSession(sessionId: string): FileStore {
  const store = new FileStore(tmpDir, sessionId);
  sessions.set(sessionId, store);
  return store;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-daemon-test-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  sessions = new Map();
  sessionMeta = new Map();
  broadcasts = [];
  app = createDaemonRoutes(
    sessions,
    sessionMeta,
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

  // C-3 — the active-session set the daemon's idle-shutdown keys on. /register
  // adds, /unregister removes — but unregister must NOT drop the session's data
  // store (the UI keeps reading it). Pre-fix, nothing ever left, so the daemon
  // (which shuts down only when activeSessions AND clients are both empty) never
  // idle-shut: one leaked process per project.
  it("tracks active sessions: register adds, unregister removes — while the data store is retained", async () => {
    const active = new Set<string>();
    const localSessions = new Map<string, FileStore>();
    const localApp = createDaemonRoutes(
      localSessions,
      new Map<string, SessionMeta>(),
      (sid) => {
        const s = new FileStore(tmpDir, sid);
        localSessions.set(sid, s);
        return s;
      },
      () => {},
      undefined,
      undefined,
      undefined,
      active,
    );

    await localApp.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });
    expect(active.has(SESSION)).toBe(true);

    const unreg = await localApp.request(`/api/internal/sessions/${SESSION}/unregister`, { method: "POST" });
    expect(unreg.status).toBe(200);
    // Active set is now empty → idle-shutdown can fire once clients also drop...
    expect(active.size).toBe(0);
    // ...but the data store is retained so the companion UI can still read it.
    expect(localSessions.has(SESSION)).toBe(true);
  });

  // II1 — when createDaemonRoutes is given an authToken, every internal
  // route requires `Authorization: Bearer <token>`. The default `app`
  // fixture above intentionally omits the token so existing tests stay
  // focused on route logic. This block builds a separately-gated app to
  // pin the gate's wire contract.
  describe("II1 — internal route auth gate", () => {
    const TOKEN = "test-token-deadbeef";
    let gatedApp: ReturnType<typeof createDaemonRoutes>;
    let gatedSessions: Map<string, FileStore>;

    beforeEach(() => {
      gatedSessions = new Map();
      const gatedMeta = new Map<string, SessionMeta>();
      gatedApp = createDaemonRoutes(
        gatedSessions,
        gatedMeta,
        (sid) => {
          const s = new FileStore(tmpDir, sid);
          gatedSessions.set(sid, s);
          return s;
        },
        () => {},
        undefined,
        undefined,
        TOKEN,
      );
    });

    it("401s when Authorization header is absent", async () => {
      const res = await gatedApp.request(`/api/internal/sessions/${SESSION}/register`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("daemon_auth_required");
    });

    it("401s when Authorization is present but the token is wrong", async () => {
      const res = await gatedApp.request(`/api/internal/sessions/${SESSION}/register`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts the request when Authorization matches the daemon's token", async () => {
      const res = await gatedApp.request(`/api/internal/sessions/${SESSION}/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("registered");
    });

    it("auth gate ONLY guards /api/internal/* (not public routes)", async () => {
      // The gate is mounted on /api/internal/*; public routes like
      // /api/daemon-info live in routes.ts and have their own posture.
      // Pin that the gate doesn't bleed onto the daemon-routes-side mounts
      // that aren't under /api/internal/ (none today, but the test
      // prevents an accidental `app.use("*", ...)` regression).
      const res = await gatedApp.request("/some-unrelated-path");
      // 404 (not 401) — auth gate didn't fire on a non-/api/internal path.
      expect(res.status).toBe(404);
    });
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
    expect(memory.rejectedApproaches.map((r: any) => r.description)).toContain("Inline refactor");
  });

  it("BB8 — memory/rejected returns 400 validation_error on missing description (not a 500)", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });
    const res = await app.request(`/api/internal/sessions/${SESSION}/memory/rejected`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "no description here" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("BB8 — memory/approved returns 400 validation_error on non-string description", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });
    const res = await app.request(`/api/internal/sessions/${SESSION}/memory/approved`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: 42 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("BB8 — memory/rejected accepts the documented typed-object shape", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });
    const res = await app.request(`/api/internal/sessions/${SESSION}/memory/rejected`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "use bcrypt rounds=4",
        reason: "brute-forceable",
        concept: "weak password hashing",
      }),
    });
    expect(res.status).toBe(200);
    const memRes = await app.request(`/api/internal/sessions/${SESSION}/memory`);
    const memory = await memRes.json();
    const entry = memory.rejectedApproaches.find((r: any) => r.description === "use bcrypt rounds=4");
    expect(entry).toBeDefined();
    expect(entry.reason).toBe("brute-forceable");
  });

  it("exposes guardrails and team-preferences routes", async () => {
    await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });

    const gRes = await app.request(`/api/internal/sessions/${SESSION}/guardrails`);
    expect(gRes.status).toBe(200);
    const gBody = await gRes.json();
    expect(Array.isArray(gBody.guardrails)).toBe(true);

    const tRes = await app.request(`/api/internal/sessions/${SESSION}/team-preferences`);
    expect(tRes.status).toBe(200);
    const tBody = await tRes.json();
    expect(Array.isArray(tBody.preferences)).toBe(true);
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

  // Y3' — orphan-session prevention. Pre-Y3', any internal-API hit
  // silently created an empty FileStore; this reopened the U0.6 orphan
  // class. Now /register is the only legitimate creator; everything else
  // 404s loud.
  describe("Y3' — requireStore (404 on unregistered session)", () => {
    it("returns 404 with code=session_not_registered for read on unknown session", async () => {
      const res = await app.request(`/api/internal/sessions/never_registered/state`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("session_not_registered");
      // No phantom store materialized.
      expect(sessions.has("never_registered")).toBe(false);
    });

    it("returns 404 for write on unknown session (artifacts POST)", async () => {
      const res = await app.request(`/api/internal/sessions/never_registered/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "art_x", type: "research", title: "x", content: {} }),
      });
      expect(res.status).toBe(404);
      expect(sessions.has("never_registered")).toBe(false);
    });

    it("/register IS the legitimate creator — succeeds + materializes the store", async () => {
      expect(sessions.has("brand_new")).toBe(false);
      const res = await app.request(`/api/internal/sessions/brand_new/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x", project: "y" }),
      });
      expect(res.status).toBe(200);
      expect(sessions.has("brand_new")).toBe(true);
    });

    it("re-register is idempotent — adopts the existing store, doesn't replace it", async () => {
      await app.request(`/api/internal/sessions/${SESSION}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const storeBefore = sessions.get(SESSION);
      // Seed an artifact so we'd notice if the store got replaced.
      await app.request(`/api/internal/sessions/${SESSION}/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "art_r", type: "research", title: "r", content: {} }),
      });
      // Re-register.
      await app.request(`/api/internal/sessions/${SESSION}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(sessions.get(SESSION)).toBe(storeBefore);
      expect(storeBefore!.getArtifacts()).toHaveLength(1);
    });
  });

  describe("Y3' — project binding (/register expectedProjectRoot)", () => {
    it("403 with code=project_mismatch when wrapper expects a different project", async () => {
      const localApp = createDaemonRoutes(
        new Map(),
        new Map(),
        createTestSession,
        () => {},
        undefined,
        "/projects/A",
      );
      const res = await localApp.request(`/api/internal/sessions/sess/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedProjectRoot: "/projects/B" }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("project_mismatch");
      expect(body.projectRoot).toBe("/projects/A");
    });

    it("200 when expectedProjectRoot matches", async () => {
      const localApp = createDaemonRoutes(
        new Map(),
        new Map(),
        createTestSession,
        () => {},
        undefined,
        "/projects/A",
      );
      const res = await localApp.request(`/api/internal/sessions/sess/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedProjectRoot: "/projects/A" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.projectRoot).toBe("/projects/A");
    });

    it("200 when expectedProjectRoot is omitted (back-compat with older wrappers)", async () => {
      const localApp = createDaemonRoutes(
        new Map(),
        new Map(),
        createTestSession,
        () => {},
        undefined,
        "/projects/A",
      );
      const res = await localApp.request(`/api/internal/sessions/sess/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });
  });

  // Z1 — preflight trace round-trip through the internal API. Pre-Z1
  // these routes didn't exist; persistPreflightTrace silently no-op'd
  // against DaemonClient so users running via the daemon (production)
  // got the broadcast but no sidecar persistence — the breadcrumb
  // disappeared on refresh.
  describe("Z1 — preflight trace round-trip", () => {
    const TRACE = {
      version: 1 as const,
      at: "2026-04-30T12:00:00.000Z",
      artifactId: "art_z1",
      toolName: "present_findings",
      decision: "admitted" as const,
      consideredCount: 3,
      consideredConcepts: [{ source: "session" as const, concept: "x" }],
      nearMisses: [],
    };

    it("POST /preflight-traces/:artifactId persists; GET reads it back", async () => {
      await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });
      const postRes = await app.request(
        `/api/internal/sessions/${SESSION}/preflight-traces/art_z1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trace: TRACE }),
        },
      );
      expect(postRes.status).toBe(200);
      const getRes = await app.request(
        `/api/internal/sessions/${SESSION}/preflight-traces/art_z1`,
      );
      expect(getRes.status).toBe(200);
      const body = await getRes.json();
      expect(body.trace.consideredCount).toBe(3);
      expect(body.trace.consideredConcepts[0].concept).toBe("x");
    });

    it("GET returns null for an artifact with no recorded trace", async () => {
      await app.request(`/api/internal/sessions/${SESSION}/register`, { method: "POST" });
      const res = await app.request(
        `/api/internal/sessions/${SESSION}/preflight-traces/art_never`,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).trace).toBeNull();
    });

    it("404s for an unregistered session (Y3' contract holds for Z1 routes)", async () => {
      const res = await app.request(
        `/api/internal/sessions/never/preflight-traces/art_x`,
      );
      expect(res.status).toBe(404);
    });
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
    sessionMeta = new Map();
    const routes = createDaemonRoutes(
      sessions,
      sessionMeta,
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

  it("Phase 3 — a severed connection with no recovery binding throws the clear sleep message, not a raw fetch error", async () => {
    // Nothing listening on this port → fetch rejects (ECONNREFUSED), mimicking
    // a sleep-severed socket. No expectedProjectRoot → recovery is refused
    // (AA6.4), so the wrapper should surface the actionable message rather than
    // the raw "fetch failed / socket connection closed unexpectedly".
    const dead = new DaemonClient(59999, "s_dead");
    await expect(
      dead.createArtifact({ id: "art_dead", type: "research", title: "x", content: { summary: "x" } }),
    ).rejects.toThrow(/daemon connection lost \(likely after host sleep\)/);
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
    await client.recordApprovedPattern({ description: "Service layer" });
    await client.recordRejectedApproach({ description: "God object" });

    const memory = await client.getSessionMemory();
    expect(memory.approvedPatterns).toContain("Service layer");
    expect(memory.rejectedApproaches.map((r) => r.description)).toContain("God object");
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

  // Z1 — preflight trace round-trip via DaemonClient (the production path).
  it("Z1: recordPreflightTrace + getPreflightTrace roundtrip", async () => {
    const trace = {
      version: 1 as const,
      at: "2026-04-30T12:00:00.000Z",
      artifactId: "art_c1",
      toolName: "present_findings",
      decision: "admitted" as const,
      consideredCount: 7,
      consideredConcepts: [
        { source: "session" as const, concept: "global mutable state", reason: "testability" },
      ],
      nearMisses: [],
    };
    await client.recordPreflightTrace("art_c1", trace);
    const got = await client.getPreflightTrace("art_c1");
    expect(got?.consideredCount).toBe(7);
    expect(got?.consideredConcepts[0].concept).toBe("global mutable state");
  });

  it("Z1: getPreflightTrace returns null for an artifact with no trace", async () => {
    const got = await client.getPreflightTrace("art_no_trace_yet");
    expect(got).toBeNull();
  });

  // Z1 — auto-recover when the daemon's session map is wiped (e.g. daemon
  // process restart while the wrapper's still alive). Pre-Z1 every
  // subsequent call returned 404 silently — `data.artifacts === undefined`
  // — and the wrapper had no idea it had gone stale.
  //
  // We can't simulate a daemon restart by mutating the outer `sessions`
  // variable: createDaemonRoutes captures its sessions param by value at
  // call time, so the running server has its own reference (the test's
  // var reassignments in beforeEach are invisible to it). Instead, prove
  // the retry path works by constructing a NEW client whose sessionId
  // was never registered — first call must auto-register + retry, not
  // throw or return undefined.
  it("Z1: auto-re-registers and retries on 404 session_not_registered", async () => {
    const freshClient = new DaemonClient(TEST_PORT, "z1_fresh_session");
    // No register() call yet — first request hits the daemon with an
    // unknown sessionId, gets 404 session_not_registered, and the
    // request() helper replays register() before retrying.
    const arts = await freshClient.getArtifacts();
    expect(Array.isArray(arts)).toBe(true);
  });

  // AA2 — meta-cache ordering, daemon_resumed broadcast, hand-rolled
  // fetches routed through request().
  describe("AA2 — recovery polish", () => {
    it("AA2: 403 project_mismatch CLEARS lastRegisterMeta (no replay of bad meta)", async () => {
      // Spin a tiny daemon-routes app pinned to a different projectRoot so
      // /register 403s on a mismatched expectedProjectRoot.
      const localApp = createDaemonRoutes(
        new Map(),
        new Map(),
        (id) => { const s = new FileStore(tmpDir, id); return s; },
        () => {},
        undefined,
        "/projects/A",
      );
      const localPort = TEST_PORT + 1;
      const localServer = serve({ fetch: localApp.fetch, port: localPort });
      const c = new DaemonClient(localPort, "aa2_meta");
      await expect(
        c.register({ expectedProjectRoot: "/projects/B" }),
      ).rejects.toThrow(/project_mismatch|project mismatch/);
      // Inspect the private field via cast to confirm clearance — this
      // is the load-bearing assertion: pre-AA2 the bad meta would still
      // be cached after the throw.
      expect((c as any).lastRegisterMeta).toBeUndefined();
      localServer?.close?.();
    });

    it("AA2: successful register CACHES meta only after the response is OK", async () => {
      const c = new DaemonClient(TEST_PORT, "aa2_cache_session");
      await c.register({ title: "x", project: "y", expectedProjectRoot: undefined });
      expect((c as any).lastRegisterMeta).toEqual({ title: "x", project: "y", expectedProjectRoot: undefined });
    });

    it("AA2: auto-recover broadcasts daemon_resumed via /recovered", async () => {
      // Use a fresh client whose sessionId is unknown to the running
      // daemon — first call goes through the recover path, which
      // fire-and-forgets a POST /recovered. Verify the broadcast lands.
      const freshClient = new DaemonClient(TEST_PORT, "aa2_recover_session");
      const before = broadcasts.length;
      await freshClient.getArtifacts();
      // Give the fire-and-forget POST a tick to land.
      await new Promise((r) => setTimeout(r, 50));
      const resumed = broadcasts.find(
        (b) => b.event.type === "daemon_resumed" && b.sessionId === "aa2_recover_session",
      );
      expect(resumed).toBeDefined();
      expect(broadcasts.length).toBeGreaterThan(before);
    });

    it("AA2: searchSessions throws on non-2xx instead of returning [] silently", async () => {
      // The test daemon doesn't mount /api/search (that's a public-route
      // app, not daemon-routes), so the call hits a 404. Pre-AA2 the
      // hand-rolled fetch swallowed the status and returned []; now
      // requestPublic throws with the structured [deepPairing] prefix.
      // This IS the load-bearing assertion — silent-fail → loud-fail.
      await expect(client.searchSessions("anything")).rejects.toThrow(/deepPairing/);
    });

    // AA6.4 — auto-recover refuses to silently rebind when register meta
    // lacked expectedProjectRoot. Production wrappers always pass it;
    // this guard catches non-standalone callers (tests, future plugins,
    // IDE extensions) so a daemon swap during a session can't bind to
    // the wrong project under their feet.
    it("AA6.4: retry path REFUSES when register meta has no expectedProjectRoot", async () => {
      // Can't simulate "wipe daemon map" from the test side (the running
      // server captured `sessions` by parameter at beforeAll time, so
      // `sessions.delete()` here doesn't affect its view — same caveat
      // as the AA2 test above). Instead: use a sessionId the daemon
      // doesn't know about so the first call genuinely 404s, AND
      // pre-populate lastRegisterMeta WITHOUT expectedProjectRoot so
      // the recover path's AA6.4 check fires.
      const c = new DaemonClient(TEST_PORT, "aa6_unknown_no_root");
      // Skip register() entirely; reach in to set lastRegisterMeta to
      // the without-binding shape the guard catches.
      (c as any).lastRegisterMeta = { title: "x", project: "y" };
      await expect(c.getArtifacts()).rejects.toThrow(
        /retry refused — register meta lacks expectedProjectRoot binding/,
      );
    });

    it("AA6.4: retry path SUCCEEDS when register meta carries expectedProjectRoot", async () => {
      const c = new DaemonClient(TEST_PORT, "aa6_unknown_with_root");
      (c as any).lastRegisterMeta = {
        title: "x", project: "y", expectedProjectRoot: "/projects/test",
      };
      // The recover path will register() with the binding — daemon
      // doesn't enforce a specific projectRoot in this test fixture, so
      // the register succeeds and the retry proceeds.
      const arts = await c.getArtifacts();
      expect(Array.isArray(arts)).toBe(true);
    });
  });

  describe("DD4 — DaemonClient register() handles both 403 codes", () => {
    function mockFetch403(code: string, errorMsg?: string) {
      const calls: any[] = [];
      const stub = (async (url: any, init?: any) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ code, error: errorMsg ?? `daemon-side ${code} message` }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      });
      return { calls, stub };
    }

    it("project_hash_mismatch (CC6 middleware path) gets the doctor-evict copy", async () => {
      const { stub } = mockFetch403("project_hash_mismatch");
      const realFetch = global.fetch;
      global.fetch = stub as any;
      try {
        const c = new DaemonClient(TEST_PORT, "dd4_session_a", "/some/root");
        await expect(c.register({ expectedProjectRoot: "/some/root" })).rejects.toThrow(
          /project_hash_mismatch.*doctor --fix/,
        );
      } finally {
        global.fetch = realFetch;
      }
    });

    it("project_mismatch (legacy /register handler path) preserves the daemon's nicer error field", async () => {
      const { stub } = mockFetch403("project_mismatch", "expected /a but daemon serves /b");
      const realFetch = global.fetch;
      global.fetch = stub as any;
      try {
        const c = new DaemonClient(TEST_PORT, "dd4_session_b", "/a");
        await expect(c.register({ expectedProjectRoot: "/a" })).rejects.toThrow(
          /project_mismatch.*expected \/a but daemon serves \/b/,
        );
      } finally {
        global.fetch = realFetch;
      }
    });
  });

  describe("CC6 — DaemonClient stamps X-Project-Hash on every request", () => {
    // These tests run with fetch fully mocked so they exercise just the
    // DaemonClient's header-injection logic — independent of any daemon
    // route's middleware. The route-side enforcement is covered separately
    // in routes.test.ts (AA4 X-Project-Hash binding).

    function mockFetchOk() {
      const calls: Array<{ url: string; headers: Record<string, string> }> = [];
      const stub = (async (url: any, init?: any) => {
        calls.push({
          url: String(url),
          headers: { ...(init?.headers ?? {}) } as Record<string, string>,
        });
        return new Response(JSON.stringify({ artifacts: [], sessions: [], status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      return { calls, stub };
    }

    it("attaches X-Project-Hash on session-scoped requests when constructed with projectRoot", async () => {
      const { calls, stub } = mockFetchOk();
      const realFetch = global.fetch;
      global.fetch = stub as any;
      try {
        const c = new DaemonClient(TEST_PORT, "cc6_session", "/some/project/root");
        await c.register({ expectedProjectRoot: "/some/project/root" });
        await c.getArtifacts();
        const sessionScoped = calls.filter((k) => k.url.includes("/api/internal/sessions/"));
        expect(sessionScoped.length).toBeGreaterThan(0);
        for (const k of sessionScoped) {
          expect(k.headers["X-Project-Hash"]).toMatch(/^[a-f0-9]{8}$/);
        }
      } finally {
        global.fetch = realFetch;
      }
    });

    it("attaches X-Project-Hash on requestPublic calls (e.g. listPastSessions)", async () => {
      const { calls, stub } = mockFetchOk();
      const realFetch = global.fetch;
      global.fetch = stub as any;
      try {
        const c = new DaemonClient(TEST_PORT, "cc6_public_session", "/another/root");
        await c.listPastSessions();
        const publicCall = calls.find((k) => k.url.endsWith("/api/sessions"));
        expect(publicCall).toBeDefined();
        expect(publicCall!.headers["X-Project-Hash"]).toMatch(/^[a-f0-9]{8}$/);
      } finally {
        global.fetch = realFetch;
      }
    });

    it("omits the header when constructed without projectRoot (back-compat)", async () => {
      const { calls, stub } = mockFetchOk();
      const realFetch = global.fetch;
      global.fetch = stub as any;
      try {
        const c = new DaemonClient(TEST_PORT, "cc6_no_root_session"); // no third arg
        await c.register();
        await c.getArtifacts();
        for (const k of calls) {
          expect(k.headers["X-Project-Hash"]).toBeUndefined();
        }
      } finally {
        global.fetch = realFetch;
      }
    });
  });

});
