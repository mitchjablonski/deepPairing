import { useMemo, useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { collectUnansweredQuestions } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { noAgentLive } from "../lib/liveness";

// Re-exported so existing importers (App.tsx) keep their import site; the
// definition now lives in lib/liveness so the store can share it without a
// store→component cycle.
export { noAgentLive };

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
/** The count of questions the ResumeQuestionsBanner would surface — exported so
 *  the TurnIndicator dedup (F2 #196 M4) can suppress the header questions badge
 *  when this banner is visible WITHOUT re-deriving the predicate (drift = a
 *  hidden badge with no banner to replace it). */
export function countResumeQuestions(comments: Record<string, Comment[]>): number {
  const all = Object.values(comments).flat() as Comment[];
  return collectUnansweredQuestions(all).length;
}

export function ResumeQuestionsBanner() {
  const comments = useArtifactStore((s) => s.comments);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const connected = useConnectionStore((s) => s.connected);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const [copied, setCopied] = useState(false);

  // Reuse the SAME shared queue definition the server carryover uses, so the
  // banner's count + jump target agree with what the agent will receive. The
  // collector targets the ACTUAL open-question comment (Fix 1 — for a reply
  // follow-up that's the tail, not the thread root) and its artifact.
  const unanswered = useMemo(() => {
    const all = Object.values(comments).flat() as Comment[];
    return collectUnansweredQuestions(all);
  }, [comments]);

  if (!connected || !noAgentLive(activeSessions) || unanswered.length === 0) return null;

  const n = unanswered.length;
  const resumePrompt =
    `Resume our deepPairing session: I left ${n} question${n === 1 ? "" : "s"} on your artifacts that ${n === 1 ? "is" : "are"} still unanswered. ` +
    `Call check_feedback to see them (they arrive as an "unanswered questions carried over" block), then reply to each with answer_question so the answer links to my question in the companion UI.`;

  const copy = async () => {
    // Fix 3 — only claim success after an ACTUAL resolve. In the VS Code webview
    // (this component's own target) navigator.clipboard is undefined; `await
    // undefined` wouldn't throw, so the old optional-chain lied with "Copied ✓".
    // Branch on presence; the count + jump keep working either way.
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!writeText) return;
    try {
      await writeText(resumePrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (permissions) — non-fatal; don't claim success.
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
