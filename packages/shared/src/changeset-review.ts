import type { ChangesetReviewState, ChangesetReviewReasons } from "./schemas/content-types.js";

/**
 * #175 — a file's DERIVED disposition in the changeset review surface.
 *
 * `reviewState` stores the raw human-set value ("reviewed" | "needs_changes" |
 * legacy "skipped"). This collapses it to the three states the UI and the
 * derived whole-changeset action actually reason about:
 *   - "reviewed"      → looks right
 *   - "needs_changes" → flagged, carries a reason (see reviewReasons)
 *   - "pending"       → not dispositioned yet. A LEGACY "skipped" maps here on
 *                       purpose: skipping was never a real "yes", so an old
 *                       changeset must be re-reviewed, not auto-unlocked.
 */
export type ChangesetDisposition = "reviewed" | "needs_changes" | "pending";

export function deriveChangesetDisposition(
  reviewState: ChangesetReviewState | undefined,
  path: string,
): ChangesetDisposition {
  const raw = reviewState?.[path];
  if (raw === "reviewed") return "reviewed";
  if (raw === "needs_changes") return "needs_changes";
  // Legacy "skipped" (and anything absent) → pending. Documented in
  // ChangesetReviewStateSchema.
  return "pending";
}

/**
 * #175 — compose the revision feedback the agent reads when the human presses
 * "Send back N". Only the FLAGGED (needs_changes) files travel — the look-right
 * files are accepted — each with its reason, so check_feedback surfaces exactly
 * "which files + why". The agent revises just these → v2 (via the existing
 * revise_artifact supersede machinery).
 *
 * Pure + shared so the companion UI (which fires the send-back) and the
 * check_feedback wire-shape test compose the same string.
 *
 * NOTE (#174 follow-up): the v2 draft starts with a FRESH review state — the
 * human's look-right marks on untouched files do NOT yet carry across the
 * version bump. Version-aware thread/mark carryover is #174, gated on an
 * id-stability decision; do not build it here.
 */
export function composeSendBackFeedback(
  flaggedPaths: string[],
  reasons: ChangesetReviewReasons | undefined,
): string {
  const paths = flaggedPaths.filter((p) => p.length > 0);
  if (paths.length === 0) return "";
  const header =
    paths.length === 1
      ? "Please revise 1 file — the rest of the changeset looks right:"
      : `Please revise ${paths.length} files — the rest of the changeset looks right:`;
  const lines = paths.map((p) => {
    const reason = reasons?.[p]?.trim();
    return reason ? `- ${p}: ${reason}` : `- ${p}: (no reason given)`;
  });
  return `${header}\n${lines.join("\n")}`;
}
