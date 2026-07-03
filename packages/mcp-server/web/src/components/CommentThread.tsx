import { useRef, useState } from "react";
import { useDraft } from "../hooks/useDraft";
import { useDismissOnOutside } from "../hooks/useDismissOnOutside";
import type { Comment, CommentTarget } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useSentFlash } from "../hooks/useSentFlash";
import { SimpleMarkdown } from "./SimpleMarkdown";

interface CommentThreadProps {
  artifactId: string;
  comments: Comment[];
  // SP4 — Partial<CommentTarget> instead of a hand-rolled subset that drifted
  // from the schema and forced `as any` reads on optionId/sectionId/visualId.
  target?: Partial<CommentTarget>;
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
          {/* Read-only delivery signal on YOUR comments, derived purely from the
              agent's drain queue (`acknowledged`). We NEVER set acknowledged
              here — that's the agent's check_feedback path. */}
          {isHuman && (comment.acknowledged
            ? (
              <span className="text-text-muted text-2xs" title="The agent has drained this comment">
                ✓ seen by agent
              </span>
            )
            : (
              <span className="text-accent-blue/70 text-2xs" title="Delivered to the session — the agent will see it the next time it checks in">
                {/* U8 — only a QUESTION leaves the agent owing a reply; a plain
                    comment/suggestion is just delivered, so don't imply the
                    agent is on the hook for it. */}
                {comment.intent === "question" ? "delivered · awaiting agent" : "delivered"}
              </span>
            ))}
        </div>
        {/* Render markdown (the agent writes **bold**, `code`, lists) instead of
            plain text — pre-this it showed the literal asterisks. */}
        <SimpleMarkdown text={comment.content} className="text-xs text-text-primary space-y-1" />

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
  // D9 (H5) — keyed per artifact+anchor so each thread keeps its own draft.
  const [input, setInput] = useDraft(`comment:${artifactId}:${JSON.stringify(target ?? {})}`);
  const [submitting, setSubmitting] = useState(false);
  const submitComment = useArtifactStore((s) => s.submitComment);
  

  const handleSubmit = async () => {
    if (!input.trim() || submitting) return;
    setSubmitting(true);
    try {
      await submitComment(artifactId, input.trim(), target);
      setInput(""); // clear only on success; keep the draft for retry on failure
    } catch {
      /* store surfaced the error toast */
    } finally {
      setSubmitting(false); // never strand the composer disabled
    }
  };

  // Render the full thread: root comments plus their replies nested beneath.
  // Pre-this, CommentThread rendered ONLY roots, so an agent reply (which
  // carries parentCommentId) was invisible on the artifact even though the
  // conversation rail showed it — a question would appear with no answer.
  const byId = new Map(comments.map((c) => [c.id, c]));
  const repliesByParent = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.parentCommentId && byId.has(c.parentCommentId)) {
      const arr = repliesByParent.get(c.parentCommentId) ?? [];
      arr.push(c);
      repliesByParent.set(c.parentCommentId, arr);
    }
  }
  // Roots = no parent, OR a parent that isn't in this filtered set (so an
  // orphaned reply still shows rather than vanishing).
  const rootComments = comments.filter(
    (c) => !c.parentCommentId || !byId.has(c.parentCommentId),
  );
  const sortByTime = (a: Comment, b: Comment) =>
    (a.createdAt ?? "").localeCompare(b.createdAt ?? "");

  return (
    <div className="space-y-3">
      {[...rootComments].sort(sortByTime).map((comment) => {
        const replies = (repliesByParent.get(comment.id) ?? []).sort(sortByTime);
        return (
          <div key={comment.id} className="space-y-2">
            <CommentBubble comment={comment} />
            {replies.length > 0 && (
              <div className="ml-7 space-y-2 border-l border-border-subtle pl-3">
                {replies.map((reply) => (
                  <CommentBubble key={reply.id} comment={reply} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="flex gap-1.5 items-end">
        <textarea
          rows={2}
          placeholder="Add a comment… (⌘⏎ to send, Enter for newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          disabled={submitting}
          className="flex-1 px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                     placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue
                     disabled:opacity-50 resize-none"
        />
        <button
          onClick={handleSubmit}
          disabled={!input.trim() || submitting}
          className="px-2.5 py-1.5 bg-accent-blue text-white text-xs rounded
                     hover:bg-accent-blue/80 disabled:bg-surface-elevated disabled:text-text-muted
                     transition-colors shrink-0"
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
  fullWidth = false,
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
    visualId?: string;
    // D8 — stable requirement identity + answerable open questions.
    requirementId?: string;
    questionIndex?: number;
  };
  /** "inline" = compact icon-button; "pill" = small labelled pill */
  variant?: "inline" | "pill";
  /** Stretch to fill its container — pairs with CommentTrigger's fullWidth so
   *  the two actions sit as equal halves of a wide bar. Pill variant only. */
  fullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const { sent, flash } = useSentFlash();
  const submitComment = useArtifactStore((s) => s.submitComment);
  const comments = useArtifactStore((s) => s.comments);
  const markQuestionResolved = useArtifactStore((s) => s.markQuestionResolved);

  // Look up existing question(s) + their answers for this target
  const artifactComments = comments[artifactId] ?? [];
  const matching = artifactComments.filter((c) => {
    if (c.intent !== "question") return false;
    if (target.findingIndex != null && c.target.findingIndex !== target.findingIndex) return false;
    if (target.stepIndex != null && c.target.stepIndex !== target.stepIndex) return false;
    // D8 review — without these arms all open questions share
    // sectionId="open-question", so one asked question pulsed on EVERY row.
    if (target.questionIndex != null && c.target.questionIndex !== target.questionIndex) return false;
    if (target.requirementId != null && c.target.requirementId !== target.requirementId) return false;
    if (target.evidenceIndex != null && c.target.evidenceIndex !== target.evidenceIndex) return false;
    if (target.alternativeIndex != null && c.target.alternativeIndex !== target.alternativeIndex) return false;
    if (target.optionId != null && c.target.optionId !== target.optionId) return false;
    if (target.sectionId != null && c.target.sectionId !== target.sectionId) return false;
    if (target.visualId != null && c.target.visualId !== target.visualId) return false;
    if (target.lineNumber != null && c.target.lineNumber !== target.lineNumber) return false;
    return true;
  });
  // A question is still "waiting" only when neither the agent answered it nor
  // the human marked it resolved themselves. humanResolvedAt clears the violet
  // pulse the same way an answer does.
  const unanswered = matching.filter((q) => !q.answeredByCommentId && !q.humanResolvedAt).length;
  const answeredQuestions = matching.filter((q) => q.answeredByCommentId);

  const send = async () => {
    const trimmed = question.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await submitComment(artifactId, trimmed, target, { intent: "question" });
      // only clear/close on success — same U4 fix as FileViewer: the store
      // rolls back + toasts + re-throws, so on failure keep the text and the
      // open popover for retry instead of stranding `sending=true` forever.
      setQuestion("");
      flash();
      setOpen(false);
    } catch {
      /* store surfaced the error; keep the draft + popover for retry */
    } finally {
      setSending(false);
    }
  };

  const classes =
    variant === "pill"
      ? `inline-flex items-center gap-1 text-2xs transition-colors font-medium ${
          fullWidth ? "w-full justify-center px-3 py-1.5 rounded-md" : "px-2 py-0.5 rounded"
        }`
      : "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors";

  const tint = unanswered > 0
    ? "bg-accent-violet-dim text-accent-violet hover:bg-accent-violet-dim/80 animate-pulse"
    : matching.length > 0
      ? "bg-accent-violet-dim/40 text-accent-violet hover:bg-accent-violet-dim/60"
      : "bg-surface-elevated text-text-muted hover:bg-surface-hover hover:text-accent-violet";

  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(rootRef, open, () => setOpen(false));

  return (
    <div ref={rootRef} className={fullWidth ? "flex-1 min-w-0" : undefined}>
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
                      <div className="mt-1 pl-3 border-l-2 border-accent-violet/30">
                        <SimpleMarkdown text={answer.content} className="text-text-secondary space-y-1" />
                      </div>
                    ) : q.humanResolvedAt ? (
                      <div className="mt-0.5 pl-3 text-text-muted italic">resolved by you</div>
                    ) : q.author === "human" ? (
                      <div className="mt-0.5 pl-3 flex items-center gap-2">
                        <span className="text-text-muted italic">awaiting answer</span>
                        <button
                          type="button"
                          onClick={() => markQuestionResolved(q.id)}
                          title="Mark this question resolved — stops it counting as waiting on the agent"
                          className="text-2xs text-accent-blue hover:underline"
                        >
                          Mark resolved
                        </button>
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
              className="px-2 py-1 bg-accent-violet-strong text-white text-2xs rounded hover:bg-accent-violet-strong/80 disabled:opacity-50 press-scale"
            >
              Ask
            </button>
          </div>
          <div className="text-[9px] text-text-muted">
            The agent will answer on its next turn
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

/** Inline comment trigger — click to start a comment on a specific location.
 *  variant="pill" renders a labelled call-to-action (e.g. "Comment on this
 *  diagram") instead of the compact icon — used where the bare top-right icon
 *  is too easy to miss (notably the visual blocks). */
export function CommentTrigger({
  artifactId,
  target,
  existingCount,
  variant = "inline",
  label,
  fullWidth = false,
}: {
  artifactId: string;
  target: Partial<CommentTarget>;
  existingCount: number;
  variant?: "inline" | "pill";
  label?: string;
  /** Stretch the pill to fill its container — a prominent, hard-to-miss CTA
   *  for large blocks (visuals). Only meaningful with variant="pill". */
  fullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const allComments = useArtifactStore((s) => s.comments[artifactId]) ?? [];
  const comments = allComments.filter((c) => {
    if (target.lineNumber != null) return c.target.lineNumber === target.lineNumber;
    if (target.evidenceIndex != null) {
      return c.target.findingIndex === target.findingIndex && c.target.evidenceIndex === target.evidenceIndex;
    }
    if (target.findingIndex != null) return c.target.findingIndex === target.findingIndex;
    // D8 review — no arm meant the badge said "1" but the popover thread was
    // EMPTY (your answer vanished on reopen, inviting a repost).
    if (target.questionIndex != null) return c.target.questionIndex === target.questionIndex;
    if (target.requirementId != null) return c.target.requirementId === target.requirementId;
    if (target.stepIndex != null) return c.target.stepIndex === target.stepIndex;
    if (target.visualId != null) return c.target.visualId === target.visualId;
    return false;
  });

  const classes =
    variant === "pill"
      ? `inline-flex items-center gap-1.5 text-2xs rounded-md font-medium transition-colors ${
          fullWidth ? "w-full justify-center px-3 py-1.5" : "px-2 py-1"
        }`
      : "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors";
  const tint =
    existingCount > 0
      ? "bg-accent-blue-dim text-accent-blue hover:bg-accent-blue-dim/80"
      : "bg-surface-elevated text-text-muted hover:bg-surface-hover hover:text-text-secondary";

  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(rootRef, open, () => setOpen(false));

  return (
    <div ref={rootRef} className={fullWidth ? "flex-1 min-w-0" : undefined}>
      <button
        onClick={() => setOpen(!open)}
        title={label ?? "Add a comment here"}
        aria-label={label ?? "Add a comment"}
        className={`${classes} ${tint}`}
      >
        <span className="text-[10px]">💬</span>
        {variant === "pill" && <span>{label ?? "Comment"}</span>}
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
