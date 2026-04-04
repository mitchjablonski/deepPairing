import { EventEmitter } from "node:events";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@deeppairing/shared";
import type {
  AgentService,
  AgentSession,
  StartSessionOptions,
} from "./agent-types.js";
import { AGENT_EVENTS, emitAgentEvent } from "./agent-types.js";
import { buildSystemPrompt } from "../prompts/system.js";
import { createDeepPairingMcpServer } from "@deeppairing/mcp-server";
import type { ArtifactStoreInterface, DecisionManagerInterface, PlanReviewResult } from "@deeppairing/mcp-server";

export interface ClaudeAgentDeps {
  artifactStore: ArtifactStoreInterface;
  decisionManager: DecisionManagerInterface;
  onPlanReview: (artifactId: string) => Promise<PlanReviewResult>;
  reasoningTracker?: {
    recordReasoning(sessionId: string): void;
    recordToolCall(sessionId: string): void;
    hasRecentReasoning(sessionId: string): boolean;
  };
}

export class ClaudeAgentService implements AgentService {
  private sessions = new Map<string, AgentSession>();
  private abortControllers = new Map<string, AbortController>();
  private deps: ClaudeAgentDeps;

  constructor(deps: ClaudeAgentDeps) {
    this.deps = deps;
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const emitter = new EventEmitter();
    const abortController = new AbortController();
    const id = options.sessionId ?? crypto.randomUUID();

    const session: AgentSession = { id, status: "running", emitter, eventBuffer: [] };
    this.sessions.set(id, session);
    this.abortControllers.set(id, abortController);

    // Bind artifact store to this session
    if ("bind" in this.deps.artifactStore) {
      (this.deps.artifactStore as any).bind(id, emitter);
    }

    // Run agent in background
    this.runAgent(session, options, abortController).catch((err) => {
      const message = err instanceof Error ? err.message : "Unknown agent error";
      emitAgentEvent(emitter, { type: "error", message });
      session.status = "error";
      emitter.emit(AGENT_EVENTS.error);
    });

    return session;
  }

  stopSession(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "completed";
      session.emitter.emit(AGENT_EVENTS.done);
    }
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  private async runAgent(
    session: AgentSession,
    options: StartSessionOptions,
    abortController: AbortController,
  ): Promise<void> {
    emitAgentEvent(session.emitter, { type: "status", phase: "gathering" });

    // Create in-process MCP server with collaboration tools
    const mcpServer = createDeepPairingMcpServer(
      {
        artifactStore: this.deps.artifactStore,
        decisionManager: this.deps.decisionManager,
      },
      this.deps.onPlanReview,
    );

    const result = query({
      prompt: options.prompt,
      options: {
        cwd: options.cwd,
        maxTurns: 50,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildSystemPrompt(),
        },
        allowedTools: [
          "Read", "Glob", "Grep", "Bash", "Edit", "Write",
          "WebSearch", "WebFetch",
        ],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController,
        settingSources: [],
        mcpServers: {
          deeppairing: mcpServer,
        },
      } as any, // Cast: Zod 3/4 type mismatch
    });

    let toolCallCounter = 0;

    for await (const message of result) {
      if (abortController.signal.aborted) break;

      const events = this.parseMessage(message, toolCallCounter);
      for (const event of events) {
        // Track reasoning for hook enforcement
        if (event.type === "tool_call" && event.tool === "deepPairing_log_reasoning") {
          this.deps.reasoningTracker?.recordReasoning(session.id);
        }
        if (event.type === "tool_call") {
          this.deps.reasoningTracker?.recordToolCall(session.id);
        }

        emitAgentEvent(session.emitter, event);
        if (event.type === "tool_call") toolCallCounter++;
      }
    }

    if (!abortController.signal.aborted) {
      session.status = "completed";
      session.emitter.emit(AGENT_EVENTS.done);
    }
  }

  private parseMessage(message: any, _toolCallCounter: number): AgentEvent[] {
    const events: AgentEvent[] = [];

    switch (message.type) {
      case "system":
        break;

      case "assistant": {
        const content = message.message?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === "text" && block.text) {
            events.push({ type: "text", content: block.text });
          }

          if (block.type === "tool_use") {
            const toolCallId = block.id ?? `tc_${Date.now()}`;
            events.push({
              type: "tool_call",
              toolCallId,
              tool: block.name ?? "Unknown",
              input: block.input ?? {},
              summary: this.summarizeToolCall(block.name, block.input),
            });
          }

          if (block.type === "tool_result") {
            const output = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : JSON.stringify(block.content);

            events.push({
              type: "tool_result",
              toolCallId: block.tool_use_id ?? `tc_${Date.now()}`,
              tool: "Unknown",
              output,
            });
          }

          if (block.type === "thinking" && block.thinking) {
            events.push({ type: "thinking", content: block.thinking });
          }
        }
        break;
      }

      case "result": {
        const resultContent = message.result?.content ?? message.message?.content;
        let text = "";

        if (typeof resultContent === "string") {
          text = resultContent;
        } else if (Array.isArray(resultContent)) {
          text = resultContent
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
        }

        if (text) {
          events.push({
            type: "result",
            content: text,
            stopReason: message.subtype ?? "end_turn",
          });
        }

        if (message.subtype?.startsWith("error")) {
          events.push({
            type: "error",
            message: `Agent stopped: ${message.subtype}`,
          });
        }
        break;
      }

      case "tool_use_summary": {
        if (message.tool_name && message.result) {
          const output = typeof message.result === "string"
            ? message.result
            : JSON.stringify(message.result);

          events.push({
            type: "tool_result",
            toolCallId: message.tool_use_id ?? `tc_${Date.now()}`,
            tool: message.tool_name,
            output,
            duration: message.duration_ms,
          });
        }
        break;
      }

      default:
        break;
    }

    return events;
  }

  private summarizeToolCall(tool: string | undefined, input: any): string {
    if (!tool || !input) return "";

    switch (tool) {
      case "Read":
        return `Read ${input.file_path ?? ""}${input.limit ? ` (first ${input.limit} lines)` : ""}`;
      case "Glob":
        return `Find files matching ${input.pattern ?? ""}`;
      case "Grep":
        return `Search for "${input.pattern ?? ""}"${input.path ? ` in ${input.path}` : ""}`;
      case "Bash":
        return `Run: ${(input.command ?? "").slice(0, 80)}`;
      case "Edit":
        return `Edit ${input.file_path ?? ""}`;
      case "Write":
        return `Write ${input.file_path ?? ""}`;
      case "WebSearch":
        return `Search: ${input.query ?? ""}`;
      case "WebFetch":
        return `Fetch: ${(input.url ?? "").slice(0, 60)}`;
      case "deepPairing_present_findings":
        return "Presenting research findings";
      case "deepPairing_present_options":
        return "Presenting decision options";
      case "deepPairing_present_plan":
        return "Presenting implementation plan";
      case "deepPairing_log_reasoning":
        return `Reasoning: ${(input.action ?? "").slice(0, 60)}`;
      case "deepPairing_check_feedback":
        return "Checking for human feedback";
      default:
        return `${tool}`;
    }
  }
}
