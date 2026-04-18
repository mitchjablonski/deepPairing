import { useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";

interface CommentThreadProps {
  artifactId: string;
  comments: Comment[];
  target?: { lineNumber?: number; findingIndex?: number; stepIndex?: number };
}

function Avatar({ author }: { author: string }) {
  const isHuman = author === "human";
  return (
    <div
      className={`w-5 h-5 rounded-full flex items-center justify-center text-2xs font-bold shrink-0 ${
        isHuman
          ? "bg-accent-blue text-white"
          : "bg-accent-violet-dim text-accent-violet"
      }`}
    >
      {isHuman ? "Y" : "A"}
    </div>
  );
}

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function CommentBubble({ comment }: { comment: Comment }) {
  const isHuman = comment.author === "human";
  const refs = (comment as any).codeReferences as Array<{
    filePath: string;
    lineStart: number;
    lineEnd: number;
    snippet?: string;
  }> | undefined;

  return (
    <div className="flex gap-2">
      <Avatar author={comment.author} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className={`text-xs font-semibold ${isHuman ? "text-accent-blue" : "text-text-muted"}`}>
            {isHuman ? "You" : "Agent"}
          </span>
          {comment.target.filePath && comment.target.lineStart && (
            <span className="font-mono text-2xs text-accent-blue/60">
              {comment.target.filePath}:{comment.target.lineStart}
              {comment.target.lineEnd && comment.target.lineEnd !== comment.target.lineStart
                ? `-${comment.target.lineEnd}` : ""}
            </span>
          )}
          <span className="text-2xs text-text-muted ml-auto">{formatTime(comment.createdAt)}</span>
          {!isHuman && comment.acknowledged && (
            <span className="text-text-muted text-2xs" title="Acknowledged">✓</span>
          )}
        </div>
        <p className="text-xs text-text-primary whitespace-pre-wrap">{comment.content}</p>

        {/* Code reference blocks */}
        {refs && refs.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {refs.map((ref, i) => (
              <div key={i} className="bg-surface-code rounded p-1.5 font-mono text-2xs">
                <div className="text-text-muted mb-0.5">
                  {ref.filePath}:{ref.lineStart}-{ref.lineEnd}
                </div>
                {ref.snippet && (
                  <pre className="whitespace-pre overflow-x-auto text-text-secondary">{ref.snippet}</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CommentThread({ artifactId, comments, target }: CommentThreadProps) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { submitComment } = useArtifactStore();
  

  const handleSubmit = async () => {
    if (!input.trim() || submitting) return;
    setSubmitting(true);
    await submitComment(artifactId, input.trim(), target);
    setInput("");
    setSubmitting(false);
  };

  const rootComments = comments.filter((c) => !c.parentCommentId);

  return (
    <div className="space-y-3">
      {rootComments.map((comment) => (
        <CommentBubble key={comment.id} comment={comment} />
      ))}

      <div className="flex gap-1.5">
        <input
          type="text"
          placeholder="Add a comment..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          disabled={submitting}
          className="flex-1 px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                     placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue
                     disabled:opacity-50"
        />
        <button
          onClick={handleSubmit}
          disabled={!input.trim() || submitting}
          className="px-2.5 py-1.5 bg-accent-blue text-white text-xs rounded
                     hover:bg-accent-blue/80 disabled:bg-surface-elevated disabled:text-text-muted
                     transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/**
 * Inline "ask why" trigger. Sibling to CommentTrigger but submits the comment
 * with intent: "question", which:
 *   1) is surfaced to the agent via check_feedback's question-priority lane
 *   2) renders as a pulsing dot in the UI until the agent answers
 *
 * Target acts the same way as CommentTrigger — lets the human pin the
 * question to a specific finding / step / evidence / option.
 */
export function AskTrigger({
  artifactId,
  target,
  variant = "inline",
}: {
  artifactId: string;
  target: {
    lineNumber?: number;
    findingIndex?: number;
    evidenceIndex?: number;
    stepIndex?: number;
    alternativeIndex?: number;
    optionId?: string;
    sectionId?: string;
  };
  /** "inline" = compact icon-button; "pill" = small labelled pill */
  variant?: "inline" | "pill";
}) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const { submitComment, comments } = useArtifactStore();

  // Look up existing question(s) + their answers for this target
  const artifactComments = (comments[artifactId] ?? []) as any[];
  const matching = artifactComments.filter((c) => {
    if (c.intent !== "question") return false;
    if (target.findingIndex != null && c.target.findingIndex !== target.findingIndex) return false;
    if (target.stepIndex != null && c.target.stepIndex !== target.stepIndex) return false;
    if (target.evidenceIndex != null && c.target.evidenceIndex !== target.evidenceIndex) return false;
    if (target.alternativeIndex != null && c.target.alternativeIndex !== target.alternativeIndex) return false;
    if (target.optionId != null && (c.target as any).optionId !== target.optionId) return false;
    if (target.sectionId != null && (c.target as any).sectionId !== target.sectionId) return false;
    if (target.lineNumber != null && c.target.lineNumber !== target.lineNumber) return false;
    return true;
  });
  const unanswered = matching.filter((q) => !q.answeredByCommentId).length;
  const answeredQuestions = matching.filter((q) => q.answeredByCommentId);

  const send = async () => {
    const trimmed = question.trim();
    if (!trimmed || sending) return;
    setSending(true);
    await submitComment(artifactId, trimmed, target, { intent: "question" });
    setQuestion("");
    setSent(true);
    setOpen(false);
    setTimeout(() => setSent(false), 2000);
    setSending(false);
  };

  const classes =
    variant === "pill"
      ? "inline-flex items-center gap-1 text-2xs px-2 py-0.5 rounded transition-colors font-medium"
      : "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors";

  const tint = unanswered > 0
    ? "bg-accent-violet-dim text-accent-violet hover:bg-accent-violet-dim/80 animate-pulse"
    : matching.length > 0
      ? "bg-accent-violet-dim/40 text-accent-violet hover:bg-accent-violet-dim/60"
      : "bg-surface-elevated text-text-muted hover:bg-surface-hover hover:text-accent-violet";

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        title={unanswered > 0 ? `${unanswered} unanswered question` : "Ask the agent about this"}
        aria-label={unanswered > 0 ? `Ask the agent — ${unanswered} unanswered question` : "Ask the agent about this"}
        className={`${classes} ${tint}`}
      >
        <span className="text-[10px] font-semibold">?</span>
        {variant === "pill" && <span>{sent ? "Asked" : "Ask why"}</span>}
        {matching.length > 0 && <span>{matching.length}</span>}
      </button>

      {open && (
        <div className="mt-1.5 p-2.5 bg-surface-elevated border border-border-default rounded-lg shadow-lg max-w-sm space-y-2">
          {/* Prior questions + answers on this target */}
          {matching.length > 0 && (
            <div className="space-y-2 pb-2 border-b border-border-subtle">
              {matching.map((q) => {
                const answer = q.answeredByCommentId
                  ? artifactComments.find((c) => c.id === q.answeredByCommentId)
                  : undefined;
                return (
                  <div key={q.id} className="text-2xs">
                    <div className="font-medium text-accent-violet">
                      ? {q.content}
                    </div>
                    {answer ? (
                      <div className="mt-1 pl-3 border-l-2 border-accent-violet/30 text-text-secondary whitespace-pre-wrap">
                        {answer.content}
                      </div>
                    ) : (
                      <div className="mt-0.5 pl-3 text-text-muted italic">awaiting answer</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex gap-1.5">
            <input
              type="text"
              autoFocus
              placeholder="Ask the agent to explain..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape") {
                  setOpen(false);
                  setQuestion("");
                }
              }}
              disabled={sending}
              className="flex-1 px-2 py-1 bg-surface-primary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet"
            />
            <button
              onClick={send}
              disabled={!question.trim() || sending}
              className="px-2 py-1 bg-accent-violet text-white text-2xs rounded hover:bg-accent-violet/80 disabled:opacity-50 press-scale"
            >
              Ask
            </button>
          </div>
          <div className="text-[9px] text-text-muted">
            Answered via <code className="font-mono">answer_question</code> in the agent's next turn
          </div>

          {/* If there are answered questions, show a hint the user can collapse */}
          {answeredQuestions.length > 0 && !unanswered && (
            <div className="text-[9px] text-text-muted italic">
              {answeredQuestions.length} previous answer{answeredQuestions.length !== 1 ? "s" : ""} above
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline comment trigger — click to start a comment on a specific location */
export function CommentTrigger({
  artifactId,
  target,
  existingCount,
}: {
  artifactId: string;
  target: { lineNumber?: number; findingIndex?: number; evidenceIndex?: number; stepIndex?: number };
  existingCount: number;
}) {
  const [open, setOpen] = useState(false);
  const allComments = useArtifactStore((s) => s.comments[artifactId]) ?? [];
  const comments = allComments.filter((c) => {
    if (target.lineNumber != null) return c.target.lineNumber === target.lineNumber;
    if (target.evidenceIndex != null) {
      return c.target.findingIndex === target.findingIndex && c.target.evidenceIndex === target.evidenceIndex;
    }
    if (target.findingIndex != null) return c.target.findingIndex === target.findingIndex;
    if (target.stepIndex != null) return c.target.stepIndex === target.stepIndex;
    return false;
  });

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors ${
          existingCount > 0
            ? "bg-accent-blue-dim text-accent-blue hover:bg-accent-blue-dim/80"
            : "bg-surface-elevated text-text-muted hover:bg-surface-hover hover:text-text-secondary"
        }`}
      >
        <span className="text-[10px]">💬</span>
        {existingCount > 0 && <span>{existingCount}</span>}
      </button>

      {open && (
        <div className="mt-1 p-2.5 bg-surface-elevated border border-border-default rounded-lg shadow-lg max-w-sm">
          <CommentThread
            artifactId={artifactId}
            comments={comments}
            target={target}
          />
        </div>
      )}
    </div>
  );
}
