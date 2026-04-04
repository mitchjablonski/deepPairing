import { EventEmitter } from "node:events";
import type { AgentEvent, CodeChangeEvent, ReasoningEvent } from "@deeppairing/shared";
import { AGENT_EVENTS, onAgentEvent } from "./agent-types.js";

export interface TrackedChange {
  filePath: string;
  changeType: "create" | "modify" | "delete";
  diff: string;
  reasoning?: ReasoningEvent;
  toolCallId: string;
}

/**
 * Watches agent events for Edit/Write tool calls and pairs them with
 * the most recent reasoning event to produce code_change events.
 */
export class DiffTracker {
  private lastReasoning: ReasoningEvent | undefined;
  private changes: TrackedChange[] = [];

  /**
   * Attach to a session's event emitter. Emits code_change events
   * back onto the same emitter when Edit/Write results are detected.
   */
  attach(emitter: EventEmitter): void {
    onAgentEvent(emitter, (event: AgentEvent) => {
      if (event.type === "reasoning") {
        this.lastReasoning = event;
      }

      if (event.type === "tool_result" && isEditTool(event.tool)) {
        const change = this.buildChange(event.toolCallId, event.tool, event.output);
        if (change) {
          this.changes.push(change);
          const codeChangeEvent: CodeChangeEvent = {
            type: "code_change",
            ...change,
          };
          emitter.emit(AGENT_EVENTS.event, codeChangeEvent);
        }
      }
    });
  }

  getChanges(): TrackedChange[] {
    return [...this.changes];
  }

  private buildChange(
    toolCallId: string,
    tool: string,
    output: string,
  ): TrackedChange | null {
    const filePath = extractFilePath(output);
    if (!filePath) return null;

    const changeType = tool === "Write" ? "create" as const : "modify" as const;
    const diff = extractDiff(output, tool);

    return {
      filePath,
      changeType,
      diff,
      reasoning: this.lastReasoning,
      toolCallId,
    };
  }
}

function isEditTool(tool: string): boolean {
  return tool === "Edit" || tool === "Write";
}

/**
 * Extract file path from tool output.
 * Edit tool results typically contain the file path in the output.
 */
function extractFilePath(output: string): string | null {
  // Match patterns like "file updated: /path/to/file" or "/path/to/file has been updated"
  const patterns = [
    /(?:updated|modified|created|written).*?([\/\\][\w\/\\.-]+\.\w+)/i,
    /([\/\\][\w\/\\.-]+\.\w+).*?(?:updated|modified|created|written)/i,
    // Fallback: first thing that looks like a file path
    /([\/\\][\w\/\\.-]+\.\w+)/,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Extract or construct a diff from tool output.
 * In a real agent, Edit tool results contain the actual diff.
 * For now, we use the raw output as the diff content.
 */
function extractDiff(output: string, _tool: string): string {
  // If the output already looks like a unified diff, use it as-is
  if (output.includes("---") && output.includes("+++")) {
    return output;
  }
  // Otherwise wrap it as a simple change description
  return output;
}
