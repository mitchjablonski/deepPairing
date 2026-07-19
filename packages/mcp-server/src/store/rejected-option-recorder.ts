import type { DecisionOption } from "@deeppairing/shared";
import type { IStore } from "./store-interface.js";

/**
 * #169 — single-source the "record a rejected decision option into the ledger"
 * shape so the TWO paths that do it can't drift:
 *
 *   1. the UNCHOSEN-options path — check_feedback, when the human PICKS one
 *      option, records the losers (check-feedback.ts).
 *   2. the WHOLE-CARD rejection path — the HTTP status route, when the human
 *      rejects the entire decision framing ("none of these") with a reason
 *      (routes.ts).
 *
 * Both key the SESSION ledger on `description` (the dedupe key,
 * `${context}: ${option.title}`) and the CROSS-PROJECT ledger on `concept`
 * (option.concept.name, falling back to option.description, then title — the
 * same priority recordRejectedApproach itself applies). Extracting it here is
 * why the AA1 concept-key regression can't reappear on one path but not the
 * other.
 */

/** ledger_write broadcast payload for a rejection. Structurally what both call
 *  sites already emitted inline. */
export type LedgerRejectionBroadcast = (event: {
  type: "ledger_write";
  kind: "rejected";
  description: string;
  concept?: string;
  reason?: string;
  sourceArtifactId?: string;
}) => void;

/** SP2 — bound the composed reason so a verbose option doesn't crowd the
 *  preflight memory's contextual budget. Display/recall only; matching is on
 *  description/concept, so truncation is lossless for the gate. */
const MAX_REASON_LEN = 240;

/**
 * Compose + bound the per-option rejection reason. Prefer the option's OWN cons
 * (its specific "why it's the worse fit"), appending `contextSuffix` (the pick
 * context on the unchosen path, or the whole-card reject framing on the HTTP
 * path). Fall back to `fallbackReason` when the option lists no cons.
 */
export function composeOptionRejectReason(
  option: Pick<DecisionOption, "cons">,
  contextSuffix: string,
  fallbackReason?: string,
): string | undefined {
  const optionCons = Array.isArray(option.cons)
    ? option.cons.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const composed = optionCons.length > 0
    ? `${optionCons.join("; ")}${contextSuffix}`
    : fallbackReason;
  return composed && composed.length > MAX_REASON_LEN
    ? `${composed.slice(0, MAX_REASON_LEN - 3)}…`
    : composed;
}

/**
 * Record ONE rejected decision option into the session ledger and broadcast the
 * matching ledger_write. `description` is the dedupe key; `concept` is the
 * cross-project key. Awaits the store write before broadcasting so the UI never
 * sees a write the store hasn't accepted.
 */
export async function recordRejectedOption(
  store: Pick<IStore, "recordRejectedApproach">,
  broadcast: LedgerRejectionBroadcast,
  params: {
    context: string;
    option: DecisionOption;
    reason?: string;
    sourceArtifactId?: string;
  },
): Promise<void> {
  const { context, option, reason, sourceArtifactId } = params;
  const description = `${context}: ${option.title}`;
  // AA1 — concept.name is the cross-project ledger key; fall back to the
  // option's prose description, then (inside recordRejectedApproach) the
  // description itself. Mirrors the winning/losing-option reads elsewhere.
  const concept: string | undefined = option.concept?.name ?? option.description ?? undefined;
  await store.recordRejectedApproach({ description, reason, sourceArtifactId, concept });
  broadcast({ type: "ledger_write", kind: "rejected", description, concept, reason, sourceArtifactId });
}

/** The concept key for a decision option: its named concept, else its prose
 *  description, else its title. This is the CROSS-PROJECT ledger key and — for
 *  the send-back path below — the ONLY key (no `${context}:` prefix). */
export function optionConceptKey(option: DecisionOption): string | undefined {
  // First NON-BLANK of concept.name → description → title (?? would keep an
  // empty-string description; we want to fall through blanks).
  for (const c of [option.concept?.name, option.description, option.title]) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

/**
 * #169 (F2) — record ONE rejected option for the "↻ None of these fit"
 * send-back gesture, keyed on the option's CONCEPT ONLY (no `${context}:`
 * prefix, unlike recordRejectedOption above).
 *
 * Why the divergence — this is load-bearing, not an oversight. The send-back
 * asks the agent for a NEW option set for the SAME question, and present_options
 * feeds the question/context in as proposal string #0. A context-prefixed key
 * ("Which cache backend?: Redis") would reverse-phrase-match that identical
 * context and HARD-BLOCK the very retry the gesture requested — self-defeating.
 * Keying on the concept ("redis for caching") instead blocks re-proposing THAT
 * option (the option's own title/description/concept still appears in the retry)
 * while the shared question — and a genuinely different option set — sails
 * through. The context-prefixed recordRejectedOption stays on the
 * unchosen-losers path (check_feedback), where an explicit PICK resolved the
 * question so a same-question re-proposal isn't expected.
 */
export async function recordRejectedOptionConcept(
  store: Pick<IStore, "recordRejectedApproach">,
  broadcast: LedgerRejectionBroadcast,
  params: {
    option: DecisionOption;
    reason?: string;
    sourceArtifactId?: string;
  },
): Promise<void> {
  const { option, reason, sourceArtifactId } = params;
  const key = optionConceptKey(option);
  if (!key) return;
  await store.recordRejectedApproach({ description: key, reason, sourceArtifactId, concept: key });
  broadcast({ type: "ledger_write", kind: "rejected", description: key, concept: key, reason, sourceArtifactId });
}
