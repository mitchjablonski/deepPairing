import type { Artifact, Comment } from "@deeppairing/shared";

/**
 * Single source of truth for "what is waiting on the human" — used by the
 * PendingBanner and the cross-project waiting badge so they can't drift apart
 * (pre-this, each computed its own filter: PendingBanner counted only
 * decision/plan, etc.).
 *
 * "Waiting on you" == draft reviewable artifacts you must act on
 * (Approve/Revise/Reject, or Dismiss → obsolete). Resolving a decision/plan
 * flips its status, so it leaves this set naturally.
 *
 * A human's own unanswered question is deliberately EXCLUDED: that's the
 * AGENT's turn (you asked it; the agent owes the answer). TurnIndicator
 * surfaces those separately as a violet "waiting on the agent" badge. Counting
 * them here kept the "waiting on YOU" signal lit on something you can't action
 * — the same exclusion lives in the daemon's computeDaemonPendingCount.
 * `isUnresolvedQuestion` is still exported for the agent-turn surfaces.
 */

/** Artifact types whose `draft` state means "the human needs to review this".
 *  `reasoning` is excluded (agent narration, no review cycle). #175 —
 *  `changeset` joins the set: a draft changeset genuinely awaits your review, so
 *  the `n` key and the changeset's own post-verdict auto-advance treat it as
 *  pending (it matches the server's PENDING_DRAFT_TYPES). #190 — `debrief` (A1)
 *  and `explainer` (A2) are review surfaces too: each renders the full
 *  Approve/Request-changes/Reject triad and is a draft awaiting the human, so it
 *  must nudge the PendingBanner just like the server counts it. This set must
 *  stay equal to the server's PENDING_DRAFT_TYPES (minus `reasoning`) — pinned by
 *  a parity test so the next artifact type can't silently miss it. */
export const REVIEWABLE_TYPES = new Set(["research", "spec", "plan", "decision", "code_change", "changeset", "debrief", "explainer"]);

export function isDraftAwaitingReview(a: Artifact): boolean {
  return a.status === "draft" && REVIEWABLE_TYPES.has(a.type);
}

/**
 * #192 (usability H1) — the noun buckets the TurnIndicator "Your turn — …"
 * summary is built from, ordered for display. EVERY REVIEWABLE_TYPE must map to
 * exactly one bucket or the summary silently omits it: pre-#192 the summary
 * counted only research/spec, decision, code_change and plan, so with ONLY a
 * changeset/debrief/explainer pending it rendered a dangling "Your turn —"
 * (nothing after the dash) while the tab badge correctly said 3. `spec` shares
 * the "finding" bucket with research (historical grouping). A parity test pins
 * flatMap(types) === REVIEWABLE_TYPES so the NEXT type can't miss it.
 */
export const TURN_PART_BUCKETS: ReadonlyArray<{ types: readonly string[]; noun: string }> = [
  { types: ["research", "spec"], noun: "finding" },
  { types: ["decision"], noun: "decision" },
  { types: ["code_change"], noun: "change" },
  { types: ["changeset"], noun: "changeset" },
  { types: ["plan"], noun: "plan" },
  { types: ["debrief"], noun: "debrief" },
  { types: ["explainer"], noun: "explainer" },
];

/**
 * Build the "Your turn — …" summary parts (e.g. ["1 finding", "1 changeset"])
 * from the pending drafts. Defensive fallback: if no bucket matched but drafts
 * exist (a brand-new type not yet bucketed), returns ["N items"] so the caller
 * never renders a dangling dash.
 */
export function summarizeTurnParts(pending: Artifact[]): string[] {
  const parts: string[] = [];
  for (const bucket of TURN_PART_BUCKETS) {
    const n = pending.filter((a) => bucket.types.includes(a.type)).length;
    if (n > 0) parts.push(`${n} ${bucket.noun}${n > 1 ? "s" : ""}`);
  }
  if (parts.length === 0 && pending.length > 0) {
    parts.push(`${pending.length} item${pending.length > 1 ? "s" : ""}`);
  }
  return parts;
}

export function isUnresolvedQuestion(c: Comment): boolean {
  return (
    c.author === "human" &&
    (c as any).intent === "question" &&
    !(c as any).answeredByCommentId &&
    !(c as any).humanResolvedAt
  );
}

export interface PendingSummary {
  /** Draft artifacts awaiting the human's review. */
  drafts: Artifact[];
  /** drafts.length — the single number the "waiting on you" badge shows. */
  total: number;
}

/**
 * Compute everything currently waiting on the human ("your turn") across an
 * artifact list. Human-asked questions are excluded — they're the agent's turn
 * (see the module docstring) and belong to the separate "waiting on the agent"
 * surface, not this count.
 *
 * Takes the per-artifact comment map for signature stability with callers even
 * though the count no longer depends on it.
 */
export function computePending(
  artifacts: Artifact[],
  _commentsByArtifact: Record<string, Comment[]> = {},
): PendingSummary {
  const drafts = artifacts.filter(isDraftAwaitingReview);
  return { drafts, total: drafts.length };
}

/**
 * J2b (#212) — lite-frame step-down. The probe's one-artifact session fired the
 * same "you have work" fact four times (header count pill + PendingBanner + the
 * turn pill's verbatim label + the card's own status badge). When EXACTLY ONE
 * draft is pending AND it is the artifact currently in view (selected), the card
 * itself IS the call to action, so the frame steps down: the PendingBanner
 * suppresses and the header turn-pill collapses to a bare count (the summary).
 *
 * Conservative by construction — returns FALSE (banner stays) for:
 *   - 0 pending (the banner already self-hides),
 *   - 2+ pending (the banner's chip strip is the only per-item triage surface),
 *   - a single pending draft that is NOT the one on screen (then the banner is
 *     the scent that lets you reach it).
 *
 * Shared so App (header-pill collapse + banner gate) and PendingBanner
 * (self-suppress) evaluate the SAME rule and can't drift — the M4 no-drift
 * principle the header-pill dedup already follows.
 */
export function isSinglePendingInView(
  artifacts: Artifact[],
  selectedArtifactId: string | null | undefined,
): boolean {
  const { drafts } = computePending(artifacts);
  return drafts.length === 1 && !!selectedArtifactId && drafts[0]!.id === selectedArtifactId;
}
