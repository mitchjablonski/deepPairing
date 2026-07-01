import { useEffect, useMemo, useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { computePending } from "../lib/pending";

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
  const selectedArtifactId = useArtifactStore((s) => s.selectedArtifactId);
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
        if (
          c.author === "human" &&
          (c as any).intent === "question" &&
          !(c as any).answeredByCommentId &&
          !(c as any).humanResolvedAt
        ) {
          out.push({ artifactId, comment: c });
        }
      }
    }
    out.sort((a, b) => a.comment.createdAt.localeCompare(b.comment.createdAt));
    return out;
  }, [comments]);

  // U2 — liveness: the newest artifact/comment timestamp. After AGENT_IDLE_MS
  // with no new activity we stop claiming "Agent working" (the old behavior
  // pulsed forever, telling the human to keep waiting on an idle/finished
  // agent). A timer flips `idle` so it updates even without a re-render.
  const lastActivityMs = useMemo(() => {
    let max = 0;
    for (const a of artifacts) {
      const t = new Date(a.createdAt).getTime();
      if (Number.isFinite(t) && t > max) max = t;
    }
    for (const list of Object.values(comments)) {
      for (const c of list as Comment[]) {
        const t = new Date(c.createdAt).getTime();
        if (Number.isFinite(t) && t > max) max = t;
      }
    }
    return max;
  }, [artifacts, comments]);

  const AGENT_IDLE_MS = 45_000;
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    setIdle(false);
    // No activity yet on a fresh session → the agent is spinning up its first
    // artifact, so keep "Agent working" rather than claiming "Up to date".
    if (!lastActivityMs) return;
    const remaining = AGENT_IDLE_MS - (Date.now() - lastActivityMs);
    if (remaining <= 0) { setIdle(true); return; }
    const t = setTimeout(() => setIdle(true), remaining);
    return () => clearTimeout(t);
  }, [lastActivityMs]);

  if (!connected) return null;

  // UX1 — derive the whose-turn signal from the SAME predicate PendingBanner
  // uses (lib/pending), so the header can't disagree with the banner. Pre-UX1
  // this used an inline filter that omitted code_change, so a draft code change
  // showed "1 waiting" in the banner but "Agent working"/"Up to date" here.
  const pending = computePending(artifacts).drafts;
  const draftResearch = pending.filter((a) => a.type === "research" || a.type === "spec");
  const pendingDecisions = pending.filter((a) => a.type === "decision");
  const pendingPlans = pending.filter((a) => a.type === "plan");
  const pendingChanges = pending.filter((a) => a.type === "code_change");

  const totalPending = pending.length;

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
    if (pendingChanges.length > 0) {
      parts.push(`${pendingChanges.length} change${pendingChanges.length > 1 ? "s" : ""}`);
    }
    if (pendingPlans.length > 0) {
      parts.push(`${pendingPlans.length} plan${pendingPlans.length > 1 ? "s" : ""}`);
    }

    // B1 — the strongest CTA in the app was a plain div: the user read "Your
    // turn" then had to go hunt in the sidebar. Clicking jumps to the first
    // pending artifact; repeated clicks cycle through them.
    const jumpToPending = () => {
      if (pending.length === 0) return;
      const idx = pending.findIndex((a) => a.id === selectedArtifactId);
      const next = pending[(idx + 1) % pending.length]; // idx=-1 → pending[0]
      selectArtifact(next.id);
    };

    return (
      <div className="flex items-center gap-2 min-w-0" role="status" aria-live="polite">
        <button
          type="button"
          onClick={jumpToPending}
          title={pending.length > 1 ? "Jump to the next item waiting on you" : "Jump to the item waiting on you"}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-accent-amber-dim text-accent-amber shrink-0 hover:brightness-110 transition-[filter] cursor-pointer"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse" />
          Your turn — {parts.join(", ")}
        </button>
        {questionsBadge}
      </div>
    );
  }

  // Agent's turn. While there's recent activity, show "Agent working" + a
  // narration line ("watch your peer think"); once idle past the threshold,
  // switch to a neutral "Up to date" so we don't pulse forever at an agent
  // that's finished or gone.
  return (
    <div className="flex items-center gap-2 min-w-0" role="status" aria-live="polite">
      {idle ? (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-surface-elevated text-text-muted shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-text-muted/50" />
          Up to date
        </div>
      ) : (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-surface-elevated text-text-muted shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
          Agent working
        </div>
      )}
      {questionsBadge}
      {!idle && latestReasoningAction && (
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
