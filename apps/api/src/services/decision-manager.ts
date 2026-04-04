import type { DecisionResponse } from "@deeppairing/shared";

interface PendingDecision {
  resolve: (response: DecisionResponse) => void;
  reject: (error: Error) => void;
  optionIds: string[];
  sessionId: string;
  createdAt: number;
}

/**
 * Manages pending decisions that block agent execution until the human responds.
 *
 * No timeouts. The agent waits as long as the human needs. If the session
 * is abandoned, call cancelSession() to clean up — don't auto-resolve.
 */
export class DecisionManager {
  private pending = new Map<string, PendingDecision>();

  /**
   * Create a pending decision that blocks until the human responds.
   * No timeout — the human takes as long as they need.
   */
  createPendingDecision(
    decisionId: string,
    optionIds: string[],
    sessionId?: string,
  ): Promise<DecisionResponse> {
    return new Promise<DecisionResponse>((resolve, reject) => {
      this.pending.set(decisionId, {
        resolve,
        reject,
        optionIds,
        sessionId: sessionId ?? "unknown",
        createdAt: Date.now(),
      });
    });
  }

  /**
   * Resolve a pending decision with the human's selection.
   */
  resolveDecision(decisionId: string, response: DecisionResponse): void {
    const pending = this.pending.get(decisionId);
    if (!pending) {
      throw new Error(`No pending decision found with id: ${decisionId}`);
    }

    if (!pending.optionIds.includes(response.optionId)) {
      throw new Error(
        `Invalid option id: ${response.optionId}. Valid options: ${pending.optionIds.join(", ")}`,
      );
    }

    this.pending.delete(decisionId);
    pending.resolve(response);
  }

  isPending(decisionId: string): boolean {
    return this.pending.has(decisionId);
  }

  getPendingIds(): string[] {
    return Array.from(this.pending.keys());
  }

  /**
   * Cancel all pending decisions for a session.
   * Called when a session is abandoned or stopped — not on timeout.
   */
  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        this.pending.delete(id);
        pending.reject(new Error(`Session ${sessionId} ended`));
      }
    }
  }

  /**
   * Cancel all pending decisions (server shutdown).
   */
  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`Decision ${id} cancelled — server shutting down`));
    }
    this.pending.clear();
  }
}
