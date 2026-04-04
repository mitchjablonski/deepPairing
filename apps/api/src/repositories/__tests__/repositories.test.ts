import { describe, it, expect, beforeEach } from "vitest";
import {
  FakeSessionRepository,
  FakeEventRepository,
  FakeDecisionRepository,
} from "../__fakes__/fake-repositories.js";

describe("FakeSessionRepository", () => {
  let repo: FakeSessionRepository;

  beforeEach(() => {
    repo = new FakeSessionRepository();
  });

  it("creates and retrieves a session", async () => {
    const session = await repo.create({
      id: "sess_1",
      status: "active",
      prompt: "Analyze codebase",
      cwd: "/tmp/project",
      agentSessionId: null,
      metadata: {},
    });

    expect(session.id).toBe("sess_1");
    expect(session.createdAt).toBeDefined();

    const retrieved = await repo.getById("sess_1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.prompt).toBe("Analyze codebase");
  });

  it("returns null for unknown session", async () => {
    const result = await repo.getById("nonexistent");
    expect(result).toBeNull();
  });

  it("lists sessions", async () => {
    await repo.create({ id: "a", status: "active", prompt: "first", cwd: "/tmp", agentSessionId: null, metadata: {} });
    await repo.create({ id: "b", status: "active", prompt: "second", cwd: "/tmp", agentSessionId: null, metadata: {} });

    const sessions = await repo.list();
    expect(sessions).toHaveLength(2);
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("updates session status", async () => {
    await repo.create({ id: "sess_2", status: "active", prompt: "test", cwd: "/tmp", agentSessionId: null, metadata: {} });

    await repo.updateStatus("sess_2", "completed");
    const session = await repo.getById("sess_2");
    expect(session!.status).toBe("completed");
  });

  it("updates agent session ID", async () => {
    await repo.create({ id: "sess_3", status: "active", prompt: "test", cwd: "/tmp", agentSessionId: null, metadata: {} });

    await repo.updateAgentSessionId("sess_3", "claude_session_abc");
    const session = await repo.getById("sess_3");
    expect(session!.agentSessionId).toBe("claude_session_abc");
  });
});

describe("FakeEventRepository", () => {
  let repo: FakeEventRepository;

  beforeEach(() => {
    repo = new FakeEventRepository();
  });

  it("appends and retrieves events", async () => {
    await repo.append({
      id: "evt_1",
      sessionId: "sess_1",
      type: "text",
      data: { type: "text", content: "Hello" },
    });

    const events = await repo.getBySession("sess_1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("text");
    expect(events[0].data).toEqual({ type: "text", content: "Hello" });
  });

  it("filters events by session", async () => {
    await repo.append({ id: "e1", sessionId: "sess_a", type: "text", data: { type: "text", content: "A" } });
    await repo.append({ id: "e2", sessionId: "sess_b", type: "text", data: { type: "text", content: "B" } });
    await repo.append({ id: "e3", sessionId: "sess_a", type: "text", data: { type: "text", content: "C" } });

    const events = await repo.getBySession("sess_a");
    expect(events).toHaveLength(2);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await repo.append({
        id: `e_${i}`,
        sessionId: "sess_1",
        type: "text",
        data: { type: "text", content: `msg ${i}` },
      });
    }

    const events = await repo.getBySession("sess_1", 5);
    expect(events).toHaveLength(5);
  });
});

describe("FakeDecisionRepository", () => {
  let repo: FakeDecisionRepository;

  beforeEach(() => {
    repo = new FakeDecisionRepository();
  });

  it("creates and retrieves a decision", async () => {
    const decision = await repo.create({
      id: "dec_1",
      sessionId: "sess_1",
      parentDecisionId: null,
      context: "How to refactor auth?",
      options: [{ id: "a", title: "Option A" }],
      selectedOptionId: null,
      humanReasoning: null,
      agentReasoning: null,
      status: "pending",
    });

    expect(decision.id).toBe("dec_1");
    expect(decision.status).toBe("pending");
    expect(decision.resolvedAt).toBeNull();

    const retrieved = await repo.getById("dec_1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.context).toBe("How to refactor auth?");
  });

  it("resolves a decision", async () => {
    await repo.create({
      id: "dec_2",
      sessionId: "sess_1",
      parentDecisionId: null,
      context: "Which approach?",
      options: [{ id: "a" }, { id: "b" }],
      selectedOptionId: null,
      humanReasoning: null,
      agentReasoning: null,
      status: "pending",
    });

    await repo.resolve("dec_2", "a", "Option A is simpler");

    const decision = await repo.getById("dec_2");
    expect(decision!.status).toBe("resolved");
    expect(decision!.selectedOptionId).toBe("a");
    expect(decision!.humanReasoning).toBe("Option A is simpler");
    expect(decision!.resolvedAt).not.toBeNull();
  });

  it("retrieves decisions by session in chronological order", async () => {
    await repo.create({ id: "d1", sessionId: "sess_1", parentDecisionId: null, context: "First", options: [], selectedOptionId: null, humanReasoning: null, agentReasoning: null, status: "resolved" });
    await repo.create({ id: "d2", sessionId: "sess_1", parentDecisionId: "d1", context: "Second", options: [], selectedOptionId: null, humanReasoning: null, agentReasoning: null, status: "pending" });
    await repo.create({ id: "d3", sessionId: "sess_2", parentDecisionId: null, context: "Other session", options: [], selectedOptionId: null, humanReasoning: null, agentReasoning: null, status: "pending" });

    const decisions = await repo.getBySession("sess_1");
    expect(decisions).toHaveLength(2);
    expect(decisions[0].id).toBe("d1");
    expect(decisions[1].id).toBe("d2");
  });

  it("returns null for unknown decision", async () => {
    const result = await repo.getById("nonexistent");
    expect(result).toBeNull();
  });
});
