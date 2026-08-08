import type { ArtifactStatus } from "@deeppairing/shared";
import type { StatusTransitionReason } from "./store-interface.js";

/**
 * O3 (#231) — cross-tab last-wins VERDICT guard.
 *
 * THE RACE: the human approves an artifact in tab A. A second, stale tab B —
 * opened before the approval, still rendering the draft review footer — POSTs
 * `rejected` for the same artifact. Pre-O3, updateArtifactStatus overwrote the
 * status unconditionally, so tab B silently REVERSED an already-final verdict
 * with no signal to either tab. That is a trust hole: a verdict the human made
 * (and the agent may already be acting on) gets flipped by a phantom click.
 *
 * THE GUARD: a HUMAN-driven verdict transition FROM one terminal verdict state
 * TO a DIFFERENT terminal verdict state (approved↔rejected↔revised) is REFUSED.
 * The route surfaces this as a 409 carrying the current truth and broadcasts the
 * real status so the stale tab refreshes to it (its footer collapses to the
 * passive verdict chip — the UI already hides verdict buttons once terminal, so
 * a CURRENT tab can never hit this; only a stale one can).
 *
 * DELIBERATELY NARROW — everything below stays normal:
 *   - draft/reviewing → any terminal state (the normal first verdict).
 *   - re-asserting the SAME verdict (approved → approved): idempotent, allowed.
 *   - AGENT-driven transitions (supersede/retract/obsolete/revise, elicit
 *     accept): those aren't human verdict flips, so their reasons aren't in the
 *     human-verdict set and are never guarded — the revise/supersede lifecycle
 *     is untouched.
 *   - the ui_dismiss_obsolete dismissal and any transition INTO a non-verdict
 *     terminal state (superseded/retracted/obsolete): not verdict↔verdict flips.
 *
 * There is intentionally NO reopen path: a human verdict is meant to be sticky,
 * and the UI offers no "reopen" gesture — refreshing the stale tab to truth is
 * the whole fix. (If a reopen product gesture is ever added, it would carry its
 * own reason outside HUMAN_VERDICT_REASONS and thus bypass this guard.)
 */

/** The reasons that mean "a human just rendered a verdict from the review UI". */
const HUMAN_VERDICT_REASONS: ReadonlySet<StatusTransitionReason> = new Set([
  "ui_approve_button",
  "ui_revise_button",
  "ui_reject_button",
  "ui_decision_resolve",
  "ui_bulk_accept",
]);

/** The terminal states a human verdict lands in. Ordered so `superseded`,
 *  `retracted`, `obsolete` (agent lifecycle / dismissals) are excluded — a flip
 *  into one of those is never a human verdict reversal. */
const TERMINAL_VERDICT_STATES: ReadonlySet<ArtifactStatus> = new Set([
  "approved",
  "revised",
  "rejected",
]);

/**
 * True when applying `to` (with `reason`) onto an artifact currently at `from`
 * would REVERSE an already-final human verdict — the cross-tab last-wins race.
 * Same-verdict re-asserts (from === to) and any non-human or non-verdict
 * transition return false.
 */
export function isCrossTerminalVerdictFlip(
  from: ArtifactStatus,
  to: ArtifactStatus,
  reason: StatusTransitionReason,
): boolean {
  return (
    HUMAN_VERDICT_REASONS.has(reason) &&
    TERMINAL_VERDICT_STATES.has(from) &&
    TERMINAL_VERDICT_STATES.has(to) &&
    from !== to
  );
}
