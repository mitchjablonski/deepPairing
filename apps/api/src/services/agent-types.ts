import { EventEmitter } from "node:events";
import type { AgentEvent } from "@deeppairing/shared";

export interface AgentSession {
  id: string;
  status: "running" | "completed" | "error";
  emitter: EventEmitter;
  /** Buffer of all emitted events — replayed when SSE client connects */
  eventBuffer: AgentEvent[];
}

export interface StartSessionOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
}

export interface AgentService {
  startSession(options: StartSessionOptions): Promise<AgentSession>;
  stopSession(sessionId: string): void;
  getSession(sessionId: string): AgentSession | undefined;
}

/** Typed event emitter helper — sessions emit these events */
export const AGENT_EVENTS = {
  event: "agent:event",
  done: "agent:done",
  error: "agent:error",
} as const;

/** Max events to keep in the replay buffer. Oldest evicted first. */
const MAX_BUFFER_SIZE = 500;

/** Emit a typed agent event on a session emitter, and buffer it */
export function emitAgentEvent(
  emitter: EventEmitter,
  event: AgentEvent,
  buffer?: AgentEvent[],
): void {
  if (buffer) {
    buffer.push(event);
    // Evict oldest events if buffer exceeds cap
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
    }
  }
  emitter.emit(AGENT_EVENTS.event, event);
}

/** Listen for typed agent events */
export function onAgentEvent(
  emitter: EventEmitter,
  handler: (event: AgentEvent) => void,
): void {
  emitter.on(AGENT_EVENTS.event, handler);
}
