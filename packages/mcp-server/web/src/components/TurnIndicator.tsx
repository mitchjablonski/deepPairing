import { useMemo } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";

/**
 * Top-header turn indicator + agent narration pill.
 *
 * States:
 *   - Disconnected → hidden
 *   - Pending human action → amber "Your turn — X findings, Y decisions"
 *   - Otherwise → blue "Agent working" + a rolling narration line pulled
 *     from the most recent log_reasoning.action. This is the "watching a
 *     peer think" mechanic: instead of a static spinner, the human sees
 *     what the agent is currently working on.
 */
export function TurnIndicator() {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const comments = useArtifactStore((s) => s.comments);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const connected = useConnectionStore((s) => s.connected);

  const latestReasoningAction = useMemo(() => {
    // Walk backward through artifacts to find the most recent reasoning
    // artifact; use its action field as the narration.
    for (let i = artifacts.length - 1; i >= 0; i--) {
      const a = artifacts[i];
      if (a.type === "reasoning" && a.status !== "superseded" && a.status !== "retracted") {
        const action = (a.content as any)?.action;
        if (typeof action === "string" && action.trim()) return action.trim();
      }
    }
    return null;
  }, [artifacts]);

  // Q4: aggregate unanswered questions across all artifacts so the badge
  // surfaces "N waiting on agent" at a glance. Points at the first-asked
  // unanswered question when clicked.
  const unanswered = useMemo(() => {
    const out: Array<{ artifactId: string; comment: Comment }> = [];
    for (const [artifactId, list] of Object.entries(comments)) {
      for (const c of list as Comment[]) {
        if (c.author === "human" && (c as any).intent === "question" && !(c as any).answeredByCommentId) {
          out.push({ artifactId, comment: c });
        }
      }
    }
    out.sort((a, b) => a.comment.createdAt.localeCompare(b.comment.createdAt));
    return out;
  }, [comments]);

  if (!connected) return null;

  const draftResearch = artifacts.filter(
    (a) => (a.type === "research" || a.type === "spec") && a.status === "draft",
  );
  const pendingDecisions = artifacts.filter(
    (a) => a.type === "decision" && a.status === "draft",
  );
  const pendingPlans = artifacts.filter(
    (a) => a.type === "plan" && a.status === "draft",
  );

  const totalPending = draftResearch.length + pendingDecisions.length + pendingPlans.length;

  // Q4 — badge rendered alongside the turn pill. Violet = "waiting on agent"
  // (inverse of the amber "your turn"). Click jumps to the oldest unanswered
  // question so the user can see what was asked.
  const questionsBadge = unanswered.length > 0 ? (
    <button
      type="button"
      onClick={() => selectArtifact(unanswered[0].artifactId)}
      title={`${unanswered.length} question${unanswered.length > 1 ? "s" : ""} waiting on the agent — click to jump`}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-accent-violet-dim text-accent-violet shrink-0 hover:bg-accent-violet-dim/80 transition-colors"
    >
      <span className="font-bold">❓</span>
      {unanswered.length} question{unanswered.length > 1 ? "s" : ""} waiting
    </button>
  ) : null;

  if (totalPending > 0) {
    const parts: string[] = [];
    if (draftResearch.length > 0) {
      parts.push(`${draftResearch.length} finding${draftResearch.length > 1 ? "s" : ""}`);
    }
    if (pendingDecisions.length > 0) {
      parts.push(`${pendingDecisions.length} decision${pendingDecisions.length > 1 ? "s" : ""}`);
    }
    if (pendingPlans.length > 0) {
      parts.push(`${pendingPlans.length} plan${pendingPlans.length > 1 ? "s" : ""}`);
    }

    return (
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-accent-amber-dim text-accent-amber shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse" />
          Your turn — {parts.join(", ")}
        </div>
        {questionsBadge}
      </div>
    );
  }

  // Agent's turn — show a narration line if we have one, otherwise a quiet pulse
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-surface-elevated text-text-muted shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
        Agent working
      </div>
      {questionsBadge}
      {latestReasoningAction && (
        <span
          className="text-2xs text-text-muted truncate italic min-w-0 max-w-md"
          title={latestReasoningAction}
        >
          {latestReasoningAction}
        </span>
      )}
    </div>
  );
}
