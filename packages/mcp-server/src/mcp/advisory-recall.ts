import { getGlobalStore } from "../store/global-store.js";
import { meaningfulTokens } from "./preflight-validator.js";

/**
 * #143 step 3 — AdvisoryRecall: the narrow seam between the present_* ADVISORY
 * cross-project nudge and wherever that cross-project memory happens to live.
 *
 * Today the only provider is the GlobalStore-backed one (the JSON ledger at
 * ~/.deeppairing/philosophy/v1.json). The interface exists so that if Claude
 * Code ever ships native machine-consumable cross-project memory, we swap the
 * provider and deprecate the global JSON without touching any call site.
 * One interface, one implementation — deliberately NOT a plugin system, no
 * flags, no second provider until there's a real one to back it.
 *
 * Scope boundary (documented-correct architecture; do not disturb):
 *   - ADVISORY ONLY. Hits surface as `source:"global"` near-misses ("you
 *     avoided this in <project> — still want it here?") and NEVER hard-block.
 *   - The hard gate is out of scope BY DESIGN. The PreToolUse hook
 *     (cli/preflight-hook-core.ts) and the LOCAL .deeppairing/preferences.json
 *     hard-block path are zero-dep and never read cross-project memory —
 *     they must not gain a dependency on this adapter.
 *   - recall / first-call-hint / ledger-health read the GlobalStore directly
 *     on purpose: they are explicit memory/UI surfaces OF the ledger, not
 *     consumers of "some cross-project recall".
 */

/** One cross-project 'avoid' stance eligible to nudge (never to block). */
export interface AdvisoryHit {
  concept: string;
  /** Basename of the project where the stance was most recently earned
   *  (omitted for user-seeded stances with no real-project instance). */
  project?: string;
  /** The reason given at that instance, if any. */
  reason?: string;
}

/** What the recall needs to know about the proposal being preflighted. */
export interface AdvisoryProposal {
  /**
   * Token-set keys (see {@link tokenSetKey}) of every concept this project
   * already handles locally — rejections (which hard-block on their own) and
   * approvals/overrides (deliberately allowed here). Hits matching one of
   * these are excluded: no redundant nudge on a concept the project has
   * already settled.
   */
  localConceptKeys: ReadonlySet<string>;
}

/**
 * Cross-project advisory recall. Implementations MUST fail open: a broken
 * backing store returns whatever was collected (possibly []) rather than
 * throwing — without the advisory overlay the gate still enforces
 * session + team, and a recall error must never break a present_* tool.
 */
export interface AdvisoryRecall {
  conceptsFor(proposal: AdvisoryProposal): AdvisoryHit[];
}

/**
 * Dedup-key basis shared by the recall and the matcher: a sorted STEMMED
 * meaningful-token set. Deliberately NOT normalizeConceptKey — that is
 * hyphen/punct-sensitive, so approved "pay-per-request hosting" would fail to
 * dedup against global-avoid "pay per request hosting" and still nudge.
 * Token-set equality collapses that variance the same way
 * isCrossProjectAdvisoryHit does. (Finding 2/3; moved verbatim from
 * tool-helpers.)
 */
export function tokenSetKey(s: string): string {
  const toks = meaningfulTokens(s);
  return toks.length ? [...toks].sort().join(" ") : "";
}

/**
 * The GlobalStore-backed provider — the inline block that used to live in
 * tool-helpers.preflightRejectedApproaches, moved verbatim. This path is
 * async/occasional so a live global read is fine. Reads are unfiltered by the
 * publish opt-in (III8 gates WRITES only).
 */
export const globalStoreAdvisoryRecall: AdvisoryRecall = {
  conceptsFor(proposal: AdvisoryProposal): AdvisoryHit[] {
    const hits: AdvisoryHit[] = [];
    try {
      for (const entry of getGlobalStore().query({ stance: "avoid", limit: 200 })) {
        const concept = entry.concept?.trim();
        if (!concept) continue;
        // Skip anything this project has already rejected (hard-blocks locally)
        // or approved/overridden (deliberately allowed here) — no redundant nudge.
        const k = tokenSetKey(concept);
        if (k && proposal.localConceptKeys.has(k)) continue;
        const nonManual = [...entry.instances].reverse().find((i) => i.project && i.project !== "manual");
        hits.push({
          concept,
          project: nonManual?.project,
          reason: nonManual?.reason,
        });
      }
    } catch {
      // Fail open (partial hits kept) — see the AdvisoryRecall contract.
    }
    return hits;
  },
};

/** The active provider. Today always the GlobalStore-backed one. */
export function getAdvisoryRecall(): AdvisoryRecall {
  return globalStoreAdvisoryRecall;
}
