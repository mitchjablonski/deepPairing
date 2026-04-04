import { describe, it, expect } from "vitest";
import { AgentEventSchema } from "@deeppairing/shared";
import type { AgentEvent } from "@deeppairing/shared";
import { FakeAgentService, researchScenario, errorScenario } from "../__fakes__/fake-agent.js";
import { AGENT_EVENTS, onAgentEvent } from "../agent-types.js";

function collectEvents(service: FakeAgentService, sessionId: string): Promise<AgentEvent[]> {
  return new Promise((resolve) => {
    const events: AgentEvent[] = [];
    const session = service.getSession(sessionId);
    if (!session) return resolve(events);

    onAgentEvent(session.emitter, (event) => {
      events.push(event);
    });

    session.emitter.on(AGENT_EVENTS.done, () => {
      resolve(events);
    });
  });
}

describe("FakeAgentService", () => {
  it("starts a session and returns a valid session object", async () => {
    const service = new FakeAgentService();
    const session = await service.startSession({
      prompt: "Analyze this codebase",
      cwd: "/tmp/test-project",
    });

    expect(session.id).toBeDefined();
    expect(session.status).toBe("running");
    expect(session.emitter).toBeDefined();
  });

  it("emits all events in the research scenario", async () => {
    const service = new FakeAgentService("research");
    const session = await service.startSession({
      prompt: "Analyze this codebase",
      cwd: "/tmp/test-project",
    });

    const events = await collectEvents(service, session.id);

    expect(events).toHaveLength(researchScenario.events.length);
  });

  it("emits valid AgentEvent objects that pass schema validation", async () => {
    const service = new FakeAgentService("research");
    const session = await service.startSession({
      prompt: "Analyze this codebase",
      cwd: "/tmp/test-project",
    });

    const events = await collectEvents(service, session.id);

    for (const event of events) {
      expect(() => AgentEventSchema.parse(event)).not.toThrow();
    }
  });

  it("marks session as completed when scenario finishes", async () => {
    const service = new FakeAgentService("research");
    const session = await service.startSession({
      prompt: "Analyze",
      cwd: "/tmp",
    });

    await collectEvents(service, session.id);

    expect(session.status).toBe("completed");
  });

  it("selects error scenario when prompt starts with 'error'", async () => {
    const service = new FakeAgentService();
    const session = await service.startSession({
      prompt: "Error in the auth module",
      cwd: "/tmp",
    });

    const events = await collectEvents(service, session.id);

    expect(events).toHaveLength(errorScenario.events.length);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe("error");
  });

  it("stops a session via stopSession", async () => {
    const service = new FakeAgentService({
      name: "slow",
      events: researchScenario.events,
      delayMs: 500, // slow enough to interrupt
    });

    const session = await service.startSession({
      prompt: "Analyze",
      cwd: "/tmp",
    });

    // Collect events for a short time, then stop
    const events: AgentEvent[] = [];
    onAgentEvent(session.emitter, (event) => events.push(event));

    // Wait for a couple events then stop
    await new Promise((resolve) => setTimeout(resolve, 600));
    service.stopSession(session.id);

    // Should have received fewer events than the full scenario
    expect(events.length).toBeLessThan(researchScenario.events.length);
    expect(session.status).toBe("completed");
  });

  it("uses custom session ID when provided", async () => {
    const service = new FakeAgentService();
    const session = await service.startSession({
      prompt: "Test",
      cwd: "/tmp",
      sessionId: "my-custom-id",
    });

    expect(session.id).toBe("my-custom-id");
    expect(service.getSession("my-custom-id")).toBe(session);
  });

  it("returns undefined for unknown session", () => {
    const service = new FakeAgentService();
    expect(service.getSession("nonexistent")).toBeUndefined();
  });

  it("includes tool call summaries in events", async () => {
    const service = new FakeAgentService("research");
    const session = await service.startSession({
      prompt: "Analyze",
      cwd: "/tmp",
    });

    const events = await collectEvents(service, session.id);
    const toolCalls = events.filter((e) => e.type === "tool_call");

    expect(toolCalls.length).toBeGreaterThan(0);
    for (const tc of toolCalls) {
      if (tc.type === "tool_call") {
        expect(tc.summary).toBeDefined();
      }
    }
  });

  it("correlates tool_call and tool_result by toolCallId", async () => {
    const service = new FakeAgentService("research");
    const session = await service.startSession({
      prompt: "Analyze",
      cwd: "/tmp",
    });

    const events = await collectEvents(service, session.id);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    const toolResults = events.filter((e) => e.type === "tool_result");

    for (const call of toolCalls) {
      if (call.type === "tool_call") {
        const matchingResult = toolResults.find(
          (r) => r.type === "tool_result" && r.toolCallId === call.toolCallId,
        );
        expect(matchingResult).toBeDefined();
      }
    }
  });
});
