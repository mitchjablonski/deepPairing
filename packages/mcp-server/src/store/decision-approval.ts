import type { DecisionLedgerSettlement, DecisionRecord, IStore } from "./store-interface.js";

/**
 * #711 gate 1 — the ledger keys for a decision's PICK, single-sourced so the
 * exact-pick path (FileStore.settleDecisionLedger: the resolve routes,
 * check_feedback's backfill and the standalone End reconcile) and the late
 * generic write (stores without that path) key the approval identically.
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

/**
 * #711 gate 1 — the resolve routes' ledger step, run AFTER the pick's flush
 * committed and its resolution settled, still inside the resolve's admission
 * permit and decision-resolve lock. Publishes the settled pick's approval
 * through the exact-pick path (IStore.settleDecisionLedger). A failure — a
 * busy preferences lock — never fails the saved pick: the record stays
 * `ledgerPending` on disk and check_feedback or the standalone End closeout
 * settles it later. The stamp rides the store's scheduled flush (which retries
 * until the disk takes it); End flushes before its marker, and a stamp lost to
 * a stop is re-derived (a re-settle is an idempotent add — see the mirror
 * limit on FileStore.settleDecisionLedger).
 */
export async function settlePickLedger(
  store: Pick<IStore, "settleDecisionLedger">,
  decisionId: string,
  log: (msg: string) => void = () => {},
): Promise<{ approval: Extract<DecisionLedgerSettlement, { kind: "recorded" }> | null; ledgerPending: boolean }> {
  if (typeof store.settleDecisionLedger !== "function") return { approval: null, ledgerPending: false };
  let out: DecisionLedgerSettlement;
  try {
    out = await store.settleDecisionLedger(decisionId);
  } catch (err) {
    log(`[decision] ${decisionId}'s choice is saved; its ledger approval is pending (${String(err)}).`);
    return { approval: null, ledgerPending: true };
  }
  if (out.kind === "unsettled") return { approval: null, ledgerPending: true };
  return { approval: out.kind === "recorded" ? out : null, ledgerPending: false };
}
