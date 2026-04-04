import type { AgentSession } from "./agent-types.js";

export class SessionStore {
  private sessions = new Map<string, AgentSession>();

  set(session: AgentSession): void {
    this.sessions.set(session.id, session);
  }

  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  list(): AgentSession[] {
    return Array.from(this.sessions.values());
  }
}
