import { isLateCommentableStatus, type Artifact } from "@deeppairing/shared";

/**
 * #189 — the WRITE-AXIS lifecycle of a reviewable artifact, derived once from
 * (status, replayActive) and consumed everywhere the changeset gates a write.
 *
 * This folds ONLY the write-gating tuple that used to be spelled out inline in
 * ChangesetArtifact (reviewActive / commentsUnlocked / replayActive → followUpLane):
 *
 *   - "review"    — the OPEN review: per-file dispositions, the derived
 *                   Approve/Send-back bar, review keyboard keys, Suggest-edit.
 *                   Draft, not replaying.
 *   - "follow_up" — review is CLOSED but late follow-up comments are still
 *                   accepted as new input (approved / late-commentable status),
 *                   not replaying. No review actions.
 *   - "frozen"    — replay is active: a historical frame rendered through the
 *                   live components. Every write is locked (unconditional).
 *   - "closed"    — terminal, non-late-commentable, not replaying: read-only.
 *
 * This is deliberately the WRITE axis only. It must NOT absorb readOnly /
 * staticPreview / narrow (the comment-anchoring + prototype-sandbox axes) —
 * folding those into one flag caused a real regression (froze live per-option
 * prototypes; see ArtifactVisuals.tsx). Keep them separate.
 */
export type ReviewLifecycle = "review" | "follow_up" | "frozen" | "closed";

export function reviewLifecycle(
  status: Artifact["status"],
  replayActive: boolean,
): ReviewLifecycle {
  // Replay is an unconditional freeze — it wins over everything else.
  if (replayActive) return "frozen";
  if (status === "draft") return "review";
  if (isLateCommentableStatus(status)) return "follow_up";
  return "closed";
}
