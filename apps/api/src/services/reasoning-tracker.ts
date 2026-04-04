/**
 * Tracks whether reasoning has been logged recently for a session.
 * Used by the hook handler to enforce "log reasoning before edits."
 */
export class ReasoningTracker {
  /** Map of sessionId → number of tool calls since last reasoning */
  private callsSinceReasoning = new Map<string, number>();
  private maxCallsBeforeExpiry: number;

  constructor(maxCallsBeforeExpiry = 5) {
    this.maxCallsBeforeExpiry = maxCallsBeforeExpiry;
  }

  /**
   * Record that reasoning was logged for a session.
   */
  recordReasoning(sessionId: string): void {
    this.callsSinceReasoning.set(sessionId, 0);
  }

  /**
   * Record that a tool call was made (increments the counter).
   */
  recordToolCall(sessionId: string): void {
    const current = this.callsSinceReasoning.get(sessionId);
    if (current !== undefined) {
      this.callsSinceReasoning.set(sessionId, current + 1);
    }
  }

  /**
   * Check if reasoning was logged recently (within maxCallsBeforeExpiry tool calls).
   */
  hasRecentReasoning(sessionId: string): boolean {
    const calls = this.callsSinceReasoning.get(sessionId);
    return calls !== undefined && calls < this.maxCallsBeforeExpiry;
  }

  /**
   * Clear tracking for a session.
   */
  clear(sessionId: string): void {
    this.callsSinceReasoning.delete(sessionId);
  }
}
