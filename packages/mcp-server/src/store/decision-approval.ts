import type { DecisionRecord } from "./store-interface.js";

/**
 * #711 gate 1 — the ledger keys for a decision's PICK, single-sourced so the
 * resolve routes (which now record the approval inside the same admission
 * permit as the pick) and check_feedback (the backstop for records resolved
 * before that) key the approval identically.
 *
 * P3 — the DECISION LABEL for every human-facing key: the short fork-naming
 * `title` when present, else the full `context` (pre-M1.1 records). The
 * blocking lanes that carry the moat are key-length-invariant (the post-colon
 * `specificNoun` lane and the concept lane), so the label choice is
 * behavior-neutral for gating; pinned in check-feedback-decision-title.test.ts.
 *
 * AA1 — concept.name is the cross-project ledger key, falling back to the
 * option description for older agents that don't supply a concept.
 *
 * #549 — only the chosen option is recorded. Picking one option is not
 * rejecting the others: unchosen options add no ledger rows.
 */
export function decisionApprovalKeys(
  d: Pick<DecisionRecord, "title" | "context" | "options" | "response">,
): { description: string; concept?: string } | null {
  const option = d.options?.find((o) => o.id === d.response?.optionId);
  if (!option) return null;
  const decisionLabel = d.title?.trim() || d.context;
  const concept: string | undefined = option.concept?.name ?? option.description ?? undefined;
  return { description: `${decisionLabel}: ${option.title}`, ...(concept !== undefined ? { concept } : {}) };
}
