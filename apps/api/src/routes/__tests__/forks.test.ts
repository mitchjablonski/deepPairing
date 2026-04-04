import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createForkRoutes } from "../forks.js";
import { ForkManager } from "../../services/fork-manager.js";
import { FakeAgentService } from "../../services/__fakes__/fake-agent.js";
import { FakeWorktreeManager } from "../../services/__fakes__/fake-worktree.js";
import { SessionStore } from "../../services/session-store.js";
import { EventEmitter } from "node:events";

function createTestApp() {
  const agentService = new FakeAgentService("research");
  const worktreeManager = new FakeWorktreeManager();
  const forkManager = new ForkManager(agentService, worktreeManager);
  const sessionStore = new SessionStore();

  // Add a fake session
  sessionStore.set({
    id: "sess_1",
    status: "running",
    emitter: new EventEmitter(),
  });

  const app = new Hono();
  app.route("/", createForkRoutes(forkManager, sessionStore));
  return { app, forkManager, sessionStore };
}

describe("POST /api/sessions/:sessionId/decisions/:decisionId/fork", () => {
  it("creates a fork", async () => {
    const { app } = createTestApp();

    const res = await app.request(
      "/api/sessions/sess_1/decisions/dec_1/fork",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "opt_a", optionTitle: "Option A" }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forkId).toMatch(/^fork_/);
  });

  it("returns 404 for unknown session", async () => {
    const { app } = createTestApp();

    const res = await app.request(
      "/api/sessions/nonexistent/decisions/dec_1/fork",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "opt_a", optionTitle: "A" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid body", async () => {
    const { app } = createTestApp();

    const res = await app.request(
      "/api/sessions/sess_1/decisions/dec_1/fork",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/:sessionId/forks", () => {
  it("returns forks for a session", async () => {
    const { app, forkManager } = createTestApp();

    await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_a",
      optionTitle: "A",
      cwd: "/tmp",
      originalPrompt: "test",
    });

    const res = await app.request("/api/sessions/sess_1/forks");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.forks).toHaveLength(1);
    expect(body.forks[0].optionId).toBe("opt_a");
  });
});

describe("GET /api/forks/:forkId", () => {
  it("returns fork details", async () => {
    const { app, forkManager } = createTestApp();

    const fork = await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_a",
      optionTitle: "A",
      cwd: "/tmp",
      originalPrompt: "test",
    });

    const res = await app.request(`/api/forks/${fork.id}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe(fork.id);
    expect(body.decisionId).toBe("dec_1");
  });

  it("returns 404 for unknown fork", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/forks/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/forks/:forkId", () => {
  it("deletes a fork", async () => {
    const { app, forkManager } = createTestApp();

    const fork = await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_a",
      optionTitle: "A",
      cwd: "/tmp",
      originalPrompt: "test",
    });

    const res = await app.request(`/api/forks/${fork.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(forkManager.getFork(fork.id)).toBeUndefined();
  });
});
