import type { Artifact } from "@deeppairing/shared";
import { useReplayStore } from "../stores/replay";
import { reviewLifecycle } from "../lib/reviewLifecycle";

/**
 * The shared WRITE-AXIS lock the narrative + decision renderers all derive
 * IDENTICALLY: an artifact is write-locked when its {@link reviewLifecycle}
 * resolves to "closed" (retracted/terminal, not replaying) or "frozen" (replay
 * is active). A locked artifact keeps its posted content readable but withholds
 * every composer (comment/ask triggers, per-item grain, evidence gutters, the
 * option grid, …). Draft ("review") and approved/late-commentable ("follow_up")
 * stay writable — the #187 late-follow-up lane is intact.
 *
 * Extracted from the byte-identical three-line IIFE copy-pasted into
 * PlanArtifact, SpecArtifact, DebriefArtifact, ExplainerArtifact,
 * ResearchArtifact, and DecisionArtifactView — one source of truth for the
 * boolean so a future lifecycle tweak lands everywhere at once.
 *
 * NOT used by ChangesetArtifact: it deliberately keeps the richer triple
 * (reviewActive / commentsUnlocked / followUpLane) because it must distinguish
 * the OPEN review lane from the late-comment lane — a distinction a single
 * boolean can't carry. Collapsing it here would re-lock its late-comment path.
 */
export function useWriteLock(status: Artifact["status"]): boolean {
  const replayActive = useReplayStore((s) => s.active);
  const lc = reviewLifecycle(status, replayActive);
  return lc === "closed" || lc === "frozen";
}
