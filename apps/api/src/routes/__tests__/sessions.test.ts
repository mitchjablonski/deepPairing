import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AgentEventSchema } from "@deeppairing/shared";
import { createSessionRoutes } from "../sessions.js";
import { FakeAgentService } from "../../services/__fakes__/fake-agent.js";
import { SessionStore } from "../../services/session-store.js";

function createTestApp() {
  const agentService = new FakeAgentService("research");
  const sessionStore = new SessionStore();
  const app = new Hono();
  app.use("/*", cors());
  app.route("/", createSessionRoutes(agentService, sessionStore));
  return { app, agentService, sessionStore };
}

describe("POST /api/sessions", () => {
  it("creates a session and returns sessionId", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Analyze this codebase",
        cwd: "/tmp/test-project",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBeDefined();
    expect(typeof body.sessionId).toBe("string");
  });

  it("rejects empty prompt", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "", cwd: "/tmp" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects missing cwd", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/:id/stream", () => {
  it("returns 404 for unknown session", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/sessions/nonexistent/stream");
    expect(res.status).toBe(404);
  });

  it("streams SSE events from the fake agent", async () => {
    const { app } = createTestApp();

    // Create session first
    const createRes = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Analyze this codebase",
        cwd: "/tmp/test-project",
      }),
    });
    const { sessionId } = await createRes.json();

    // Stream events
    const streamRes = await app.request(`/api/sessions/${sessionId}/stream`);
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream");

    // Read the full stream
    const text = await streamRes.text();

    // Parse SSE events
    const events = text
      .split("\n\n")
      .filter((block) => block.includes("data:"))
      .map((block) => {
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) return null;
        return JSON.parse(dataLine.slice(5).trim());
      })
      .filter(Boolean);

    // First event should be "connected"
    expect(events[0]).toHaveProperty("sessionId");

    // Should have agent events that pass schema validation
    const agentEvents = events.filter((e: any) => e.type && e.type !== "connected");
    expect(agentEvents.length).toBeGreaterThan(0);

    for (const event of agentEvents) {
      if ("status" in event && !("phase" in event)) continue; // skip done events
      expect(() => AgentEventSchema.parse(event)).not.toThrow();
    }
  });
});

describe("POST /api/sessions/:id/stop", () => {
  it("returns 404 for unknown session", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/sessions/nonexistent/stop", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("stops an active session", async () => {
    const { app, sessionStore } = createTestApp();

    // Create session
    const createRes = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Analyze this codebase",
        cwd: "/tmp/test-project",
      }),
    });
    const { sessionId } = await createRes.json();

    // Stop it
    const stopRes = await app.request(`/api/sessions/${sessionId}/stop`, {
      method: "POST",
    });
    expect(stopRes.status).toBe(200);

    const body = await stopRes.json();
    expect(body.status).toBe("stopped");

    // Session should be completed
    const session = sessionStore.get(sessionId);
    expect(session?.status).toBe("completed");
  });
});
