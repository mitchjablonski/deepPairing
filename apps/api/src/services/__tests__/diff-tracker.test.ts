import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { AgentEvent, CodeChangeEvent } from "@deeppairing/shared";
import { DiffTracker } from "../diff-tracker.js";
import { emitAgentEvent, AGENT_EVENTS, onAgentEvent } from "../agent-types.js";

function createEmitter() {
  return new EventEmitter();
}

describe("DiffTracker", () => {
  it("emits code_change event when Edit tool result is detected", () => {
    const emitter = createEmitter();
    const tracker = new DiffTracker();
    tracker.attach(emitter);

    const changes: CodeChangeEvent[] = [];
    onAgentEvent(emitter, (event: AgentEvent) => {
      if (event.type === "code_change") {
        changes.push(event);
      }
    });

    // Emit a tool result for an Edit
    emitAgentEvent(emitter, {
      type: "tool_result",
      toolCallId: "tc_001",
      tool: "Edit",
      output: `File updated: /src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1 +1 @@
-old code
+new code`,
      duration: 50,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0].filePath).toBe("/src/auth.ts");
    expect(changes[0].changeType).toBe("modify");
    expect(changes[0].diff).toContain("---");
  });

  it("associates most recent reasoning with the change", () => {
    const emitter = createEmitter();
    const tracker = new DiffTracker();
    tracker.attach(emitter);

    const changes: CodeChangeEvent[] = [];
    onAgentEvent(emitter, (event: AgentEvent) => {
      if (event.type === "code_change") {
        changes.push(event);
      }
    });

    // Emit reasoning first
    emitAgentEvent(emitter, {
      type: "reasoning",
      action: "Improve password hashing",
      reasoning: "Switch to argon2 for better security.",
      confidence: "high",
    });

    // Then emit an Edit result
    emitAgentEvent(emitter, {
      type: "tool_result",
      toolCallId: "tc_002",
      tool: "Edit",
      output: "File updated: /src/validate.ts\n--- a/src/validate.ts\n+++ b/src/validate.ts",
      duration: 30,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0].reasoning).toBeDefined();
    expect(changes[0].reasoning?.action).toBe("Improve password hashing");
  });

  it("detects Write tool results as create changes", () => {
    const emitter = createEmitter();
    const tracker = new DiffTracker();
    tracker.attach(emitter);

    const changes: CodeChangeEvent[] = [];
    onAgentEvent(emitter, (event: AgentEvent) => {
      if (event.type === "code_change") changes.push(event);
    });

    emitAgentEvent(emitter, {
      type: "tool_result",
      toolCallId: "tc_003",
      tool: "Write",
      output: "File created: /src/new-file.ts\nContent written successfully",
      duration: 20,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("create");
    expect(changes[0].filePath).toBe("/src/new-file.ts");
  });

  it("ignores non-Edit/Write tool results", () => {
    const emitter = createEmitter();
    const tracker = new DiffTracker();
    tracker.attach(emitter);

    const changes: CodeChangeEvent[] = [];
    onAgentEvent(emitter, (event: AgentEvent) => {
      if (event.type === "code_change") changes.push(event);
    });

    emitAgentEvent(emitter, {
      type: "tool_result",
      toolCallId: "tc_004",
      tool: "Read",
      output: "File content from /src/auth.ts",
      duration: 10,
    });

    emitAgentEvent(emitter, {
      type: "tool_result",
      toolCallId: "tc_005",
      tool: "Grep",
      output: "/src/auth.ts:5: some match",
      duration: 15,
    });

    expect(changes).toHaveLength(0);
  });

  it("tracks multiple changes", () => {
    const emitter = createEmitter();
    const tracker = new DiffTracker();
    tracker.attach(emitter);

    emitAgentEvent(emitter, {
      type: "tool_result",
      toolCallId: "tc_a",
      tool: "Edit",
      output: "File updated: /src/a.ts\n---\n+++",
      duration: 10,
    });

    emitAgentEvent(emitter, {
      type: "tool_result",
      toolCallId: "tc_b",
      tool: "Edit",
      output: "File updated: /src/b.ts\n---\n+++",
      duration: 10,
    });

    expect(tracker.getChanges()).toHaveLength(2);
    expect(tracker.getChanges()[0].filePath).toBe("/src/a.ts");
    expect(tracker.getChanges()[1].filePath).toBe("/src/b.ts");
  });

  it("updates reasoning reference as new reasoning is logged", () => {
    const emitter = createEmitter();
    const tracker = new DiffTracker();
    tracker.attach(emitter);

    const changes: CodeChangeEvent[] = [];
    onAgentEvent(emitter, (event: AgentEvent) => {
      if (event.type === "code_change") changes.push(event);
    });

    emitAgentEvent(emitter, {
      type: "reasoning",
      action: "First reason",
      reasoning: "First explanation",
      confidence: "high",
    });

    emitAgentEvent(emitter, {
      type: "tool_result",
      toolCallId: "tc_1",
      tool: "Edit",
      output: "File updated: /src/first.ts",
      duration: 10,
    });

    emitAgentEvent(emitter, {
      type: "reasoning",
      action: "Second reason",
      reasoning: "Second explanation",
      confidence: "medium",
    });

    emitAgentEvent(emitter, {
      type: "tool_result",
      toolCallId: "tc_2",
      tool: "Edit",
      output: "File updated: /src/second.ts",
      duration: 10,
    });

    expect(changes[0].reasoning?.action).toBe("First reason");
    expect(changes[1].reasoning?.action).toBe("Second reason");
  });
});
