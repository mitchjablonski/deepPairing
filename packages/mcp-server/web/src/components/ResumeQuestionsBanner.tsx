import { useMemo, useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { buildThreads, isUnansweredQuestion } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";

/**
 * #192 (serving H1) — the "questions waiting for Claude" affordance.
 *
 * When the human asked questions the agent never answered AND no agent is
 * currently live (it exited — the debrief/explainer ask-anything threads invite
 * questions at exactly the moment the agent stops polling), those questions
 * would otherwise sit silently until the human re-raises them. This quiet strip
 * makes them visible and hands the human a one-click resume prompt to paste back
 * into Claude Code — the agent's first-call hint + check_feedback carryover then
 * deliver the questions on the next run without re-typing them.
 *
 * Lives in the banner row (below the header), NOT in an artifact footer — the
 * E2 batch owns those. Renders ONLY when the daemon is connected, questions are
 * open, and no agent session is live; otherwise the TurnIndicator's "waiting on
 * the agent" badge already covers the agent's-turn case.
 */
export function ResumeQuestionsBanner() {
  const comments = useArtifactStore((s) => s.comments);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const connected = useConnectionStore((s) => s.connected);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const [copied, setCopied] = useState(false);

  const unanswered = useMemo(() => {
    const out: Array<{ artifactId: string; comment: Comment }> = [];
    for (const [artifactId, list] of Object.entries(comments)) {
      for (const t of buildThreads(list as Comment[])) {
        if (isUnansweredQuestion(t.root, t.replies)) out.push({ artifactId, comment: t.root });
      }
    }
    out.sort((a, b) => a.comment.createdAt.localeCompare(b.comment.createdAt));
    return out;
  }, [comments]);

  // No agent is live when no registered session reports live !== false (an
  // exited agent is marked live:false; zero sessions is also "no agent").
  const anyAgentLive = activeSessions.some((s) => s.live !== false);

  if (!connected || anyAgentLive || unanswered.length === 0) return null;

  const n = unanswered.length;
  const resumePrompt =
    `Resume our deepPairing session: I left ${n} question${n === 1 ? "" : "s"} on your artifacts that ${n === 1 ? "is" : "are"} still unanswered. ` +
    `Call check_feedback to see them (they arrive as an "unanswered questions carried over" block), then reply to each with answer_question so the answer links to my question in the companion UI.`;

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(resumePrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (permissions/older browser) — non-fatal; the strip
      // still surfaces the count and the jump affordance.
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      // Mirrors PendingBanner's proven-AA-contrast treatment (tinted strip +
      // full-strength colored label) so the small text keeps 4.5:1.
      className="px-3 py-1.5 bg-accent-violet-dim/50 border-b border-accent-violet/15 flex items-center gap-2"
    >
      <span className="text-2xs shrink-0" aria-hidden="true">💤</span>
      <button
        type="button"
        onClick={() => { const first = unanswered[0]; if (first) selectArtifact(first.artifactId); }}
        className="text-2xs text-accent-violet font-medium shrink-0 hover:underline"
        title={`${n} question${n === 1 ? "" : "s"} the agent never answered — it exited; resume it to answer ${n === 1 ? "it" : "them"}. Click to jump to the oldest.`}
      >
        {n} question{n === 1 ? "" : "s"} waiting for Claude
      </button>
      <button
        type="button"
        onClick={copy}
        className="ml-auto shrink-0 px-2 py-0.5 rounded text-2xs font-medium bg-accent-violet-dim text-accent-violet hover:bg-accent-violet-dim/80 transition-colors"
        title="Copy a paste-able resume prompt for Claude Code"
      >
        {copied ? "Copied ✓" : "Copy resume prompt"}
      </button>
    </div>
  );
}
