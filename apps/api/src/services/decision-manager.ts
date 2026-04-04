import type { DecisionResponse } from "@deeppairing/shared";

interface PendingDecision {
  resolve: (response: DecisionResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  optionIds: string[];
}

export class DecisionManager {
  private pending = new Map<string, PendingDecision>();
  private timeoutMs: number;

  constructor(timeoutMs = 5 * 60 * 1000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Create a pending decision that blocks until resolved.
   * Returns a Promise that resolves when the human responds.
   */
  createPendingDecision(
    decisionId: string,
    optionIds: string[],
  ): Promise<DecisionResponse> {
    return new Promise<DecisionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(decisionId);
        reject(new Error(`Decision ${decisionId} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(decisionId, { resolve, reject, timer, optionIds });
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

    clearTimeout(pending.timer);
    this.pending.delete(decisionId);
    pending.resolve(response);
  }

  /**
   * Check if a decision is pending.
   */
  isPending(decisionId: string): boolean {
    return this.pending.has(decisionId);
  }

  /**
   * Get all pending decision IDs.
   */
  getPendingIds(): string[] {
    return Array.from(this.pending.keys());
  }

  /**
   * Cancel all pending decisions (cleanup).
   */
  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Decision ${id} cancelled`));
    }
    this.pending.clear();
  }
}
