export type ReplyMode = "comment" | "question";

/**
 * Compact Comment/Ask segmented switch for a REPLY composer. Mirrors the
 * LineComposer's Comment/Ask control (same tints + density) so the reply
 * surfaces read consistently — a small, misclick-safe toggle, not a new
 * pattern. Default stays "comment"; "question" is the opt-in.
 *
 * Why it matters: a plain reply is stored with intent undefined and never
 * re-opens the thread. A reply sent in "question" mode carries
 * intent:"question", so `isUnansweredQuestion`'s tail-walk sees an open human
 * follow-up and re-flags the thread as awaiting the agent (the #130 gap this
 * closes). The human can still Mark it resolved to clear it again.
 */
export function ReplyModeToggle({
  mode,
  setMode,
}: {
  mode: ReplyMode;
  setMode: (m: ReplyMode) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Reply type">
      <button
        type="button"
        onClick={() => setMode("comment")}
        aria-pressed={mode === "comment"}
        title="Reply with a plain comment (delivered, no answer owed)"
        className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors ${
          mode === "comment"
            ? "bg-accent-blue-dim text-accent-blue"
            : "text-text-muted hover:text-text-secondary"
        }`}
      >
        Comment
      </button>
      <button
        type="button"
        onClick={() => setMode("question")}
        aria-pressed={mode === "question"}
        title="Ask a follow-up question — re-flags the thread as awaiting the agent's answer"
        className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors ${
          mode === "question"
            ? "bg-accent-violet-dim text-accent-violet"
            : "text-text-muted hover:text-text-secondary"
        }`}
      >
        Ask
      </button>
    </div>
  );
}
