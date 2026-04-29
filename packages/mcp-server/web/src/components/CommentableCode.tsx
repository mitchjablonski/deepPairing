import { useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useHighlightedCode } from "../hooks/useHighlightedCode";
import { detectLanguage } from "../lib/highlighter";

interface CommentableCodeProps {
  code: string;
  language?: string;
  lineStart?: number;
  filePath?: string;
  artifactId: string;
  /** Existing comments keyed by line number */
  commentsByLine?: Map<number, Comment[]>;
  /** Additional context for the comment target */
  targetContext?: {
    findingIndex?: number;
    evidenceIndex?: number;
    stepIndex?: number;
  };
}

type LineMode = "comment" | "suggest" | "ask";

export function CommentableCode({
  code,
  language,
  lineStart = 1,
  filePath,
  artifactId,
  commentsByLine,
  targetContext,
}: CommentableCodeProps) {
  const [activeCommentLine, setActiveCommentLine] = useState<number | null>(null);
  const [activeCommentLineEnd, setActiveCommentLineEnd] = useState<number | null>(null);
  const [mode, setMode] = useState<LineMode>("comment");
  const [commentText, setCommentText] = useState("");
  const [suggestionText, setSuggestionText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Threaded-reply state. When set to a comment id, a mini-composer
  // renders directly under that chip; submit posts with parentCommentId
  // pointing at it. Mutually exclusive with the line-level composer
  // above so the user can't accidentally start two drafts at once.
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replySubmitting, setReplySubmitting] = useState(false);
  const { submitComment } = useArtifactStore();
  

  const safeCode = code ?? "";
  const resolvedLang = language ?? (filePath ? detectLanguage(filePath) : "text");
  const { lines: highlightedLines } = useHighlightedCode(safeCode, resolvedLang);
  const plainLines = safeCode.split("\n");
  const lines = plainLines;

  const handleSubmit = async (lineNum: number) => {
    if (submitting) return;
    // R2: span comments. Default lineEnd to lineNum (single-line); the user
    // can extend it via the form's "to L{x}" input. Clamp to the file
    // length and never allow a backwards range.
    const totalLines = lineStart + lines.length - 1;
    const rawEnd = activeCommentLineEnd ?? lineNum;
    const safeEnd = Math.max(lineNum, Math.min(rawEnd, totalLines));

    if (mode === "suggest") {
      if (!suggestionText.trim()) return;
      setSubmitting(true);
      const original = lines[lineNum - lineStart] ?? "";
      await submitComment(
        artifactId,
        `Suggestion: replace line ${lineNum}\n\`\`\`\n${original}\n\`\`\`\nwith:\n\`\`\`\n${suggestionText}\n\`\`\``,
        {
          lineStart: lineNum,
          lineEnd: lineNum,  // suggestions stay single-line — they replace one specific line
          filePath,
          suggestion: suggestionText,
          ...targetContext,
        },
      );
    } else {
      if (!commentText.trim()) return;
      setSubmitting(true);
      await submitComment(
        artifactId,
        commentText.trim(),
        {
          lineStart: lineNum,
          lineEnd: safeEnd,
          filePath,
          ...targetContext,
        },
        mode === "ask" ? { intent: "question" } : undefined,
      );
    }

    setCommentText("");
    setSuggestionText("");
    setMode("comment");
    setActiveCommentLine(null);
    setActiveCommentLineEnd(null);
    setSubmitting(false);
  };

  const openCommentLine = (lineNum: number, initialMode: LineMode = "comment") => {
    setActiveCommentLine(lineNum);
    setActiveCommentLineEnd(lineNum);
    setCommentText("");
    setSuggestionText("");
    setMode(initialMode);
  };

  const closeCommentLine = () => {
    setActiveCommentLine(null);
    setActiveCommentLineEnd(null);
    setCommentText("");
    setSuggestionText("");
    setMode("comment");
  };

  const startReply = (parent: Comment) => {
    // Close the line-level composer so we don't render two drafts at
    // once. Anchor the reply to the parent comment's target so the
    // reply renders on the same line/finding/evidence.
    closeCommentLine();
    setReplyingTo(parent.id);
    setReplyText("");
  };

  const cancelReply = () => {
    setReplyingTo(null);
    setReplyText("");
  };

  const submitReply = async (parent: Comment) => {
    const text = replyText.trim();
    if (!text || replySubmitting) return;
    setReplySubmitting(true);
    try {
      await submitComment(
        artifactId,
        text,
        // Reply inherits the parent's target so it lands on the same
        // line/evidence/finding and renders threaded. Strip artifactId
        // from target since submitComment re-applies it.
        { ...(parent.target ?? {}), artifactId: undefined } as any,
        { parentCommentId: parent.id },
      );
      cancelReply();
    } finally {
      setReplySubmitting(false);
    }
  };

  return (
    <div className="font-mono text-[13px] leading-[20px] bg-surface-code rounded overflow-hidden">
      {lines.map((line, i) => {
        const lineNum = lineStart + i;
        const lineComments = commentsByLine?.get(lineNum) ?? [];
        const isCommentActive = activeCommentLine === lineNum;

        return (
          <div key={i}>
            {/* Code line */}
            <div className="flex group">
              {/* Gutter with + (comment) and ? (ask) icons */}
              <div className="w-14 shrink-0 flex items-center justify-end pr-1 gap-0.5 select-none">
                <button
                  onClick={() => {
                    if (isCommentActive && mode === "ask") {
                      closeCommentLine();
                    } else {
                      openCommentLine(lineNum, "ask");
                    }
                  }}
                  className={`w-4 h-4 flex items-center justify-center rounded text-[10px] font-semibold transition-all ${
                    isCommentActive && mode === "ask"
                      ? "bg-accent-violet text-white"
                      : "opacity-0 group-hover:opacity-100 bg-accent-violet/80 text-white hover:bg-accent-violet"
                  }`}
                  title="Ask the agent about this line"
                  aria-label="Ask a question about this line"
                >
                  ?
                </button>
                <button
                  onClick={() => {
                    if (isCommentActive && mode !== "ask") {
                      closeCommentLine();
                    } else {
                      openCommentLine(lineNum, "comment");
                    }
                  }}
                  className={`w-4 h-4 flex items-center justify-center rounded text-[10px] transition-all ${
                    (isCommentActive && mode !== "ask") || lineComments.length > 0
                      ? "bg-accent-blue text-white"
                      : "opacity-0 group-hover:opacity-100 bg-accent-blue/80 text-white hover:bg-accent-blue"
                  }`}
                  title="Add comment on this line"
                  aria-label="Add a comment on this line"
                >
                  {lineComments.length > 0 ? lineComments.length : "+"}
                </button>
              </div>

              {/* Line number */}
              <span className="w-8 shrink-0 text-right pr-2 py-0.5 text-text-muted select-none border-r border-border-subtle text-[11px]">
                {lineNum}
              </span>

              {/* Code content — syntax highlighted when available, never truncated */}
              {highlightedLines?.[i] ? (
                <span
                  className="px-3 py-0.5 whitespace-pre flex-1 overflow-x-auto"
                  dangerouslySetInnerHTML={{ __html: highlightedLines[i] || "&nbsp;" }}
                />
              ) : (
                <span className="px-3 py-0.5 whitespace-pre flex-1 text-text-primary overflow-x-auto">
                  {line || " "}
                </span>
              )}
            </div>

            {/* Existing comments on this line.
                R1: span comments live in every line bucket from lineStart→lineEnd.
                Render the full chip only on the START line; compact "↳ from L{n}"
                marker on continuation lines so the user sees the comment exists
                without four duplicate chips.
                X2.5: replies thread visually under their parent. Three-deep
                threads (Q → A → follow-up) render with the same nested
                ↳ + left-border indent the ConversationRail uses, so the
                inline view and the rail tell the same story. */}
            {lineComments.length > 0 && !isCommentActive && (() => {
              // Partition: continuations (span overflow from other start
              // lines) vs primary chips that belong to THIS line.
              const continuations: Comment[] = [];
              const primary: Comment[] = [];
              for (const c of lineComments) {
                const cStart = (c.target as any).lineStart as number | undefined;
                if (cStart != null && cStart !== lineNum) continuations.push(c);
                else primary.push(c);
              }
              // Resolve each comment's ultimate top-level ancestor in the
              // parent-chain: walk parentCommentId up until we hit either
              // a comment without a parent, or a parent that isn't in this
              // bucket (orphan defensive). Then group ALL replies — any
              // depth — under the top they descend from. The rail does
              // the same flattening; both surfaces tell one story.
              const byId = new Map(primary.map((c) => [c.id, c]));
              const ultimateTopOf = (c: Comment): Comment => {
                const seen = new Set<string>();
                let cur: Comment | undefined = c;
                while (cur && cur.parentCommentId && byId.has(cur.parentCommentId)) {
                  if (seen.has(cur.id)) break; // cycle defensive
                  seen.add(cur.id);
                  cur = byId.get(cur.parentCommentId);
                }
                return cur ?? c;
              };
              const repliesByTop = new Map<string, Comment[]>();
              const tops: Comment[] = [];
              const topIds = new Set<string>();
              for (const c of primary) {
                const top = ultimateTopOf(c);
                if (top.id === c.id) {
                  // c is itself a top-level
                  if (!topIds.has(c.id)) {
                    topIds.add(c.id);
                    tops.push(c);
                  }
                } else {
                  const arr = repliesByTop.get(top.id) ?? [];
                  arr.push(c);
                  repliesByTop.set(top.id, arr);
                  // Make sure the top is registered even if iteration
                  // hit the reply before the parent.
                  if (!topIds.has(top.id)) {
                    topIds.add(top.id);
                    tops.push(top);
                  }
                }
              }

              const renderChip = (c: Comment, isReply: boolean) => {
                const cStart = (c.target as any).lineStart as number | undefined;
                const cEnd = (c.target as any).lineEnd as number | undefined;
                const spanLabel = cStart != null && cEnd != null && cStart !== cEnd
                  ? ` (lines ${cStart}–${cEnd})`
                  : "";
                return (
                  <div key={c.id} className="mb-0.5">
                    <div className="flex items-start gap-2 px-3 py-1.5 bg-accent-blue-dim/60 rounded text-xs">
                      <span className={`font-semibold shrink-0 ${c.author === "human" ? "text-accent-blue" : "text-text-muted"}`}>
                        {isReply && <span className="opacity-60 mr-1" aria-hidden>↳</span>}
                        {c.author === "human" ? "You" : "Agent"}{spanLabel}:
                      </span>
                      <span className="text-text-secondary flex-1">{c.content}</span>
                      {/* Reply affordance — agent comments + any human follow-up
                          a reply chain. Lets a 3+ deep thread keep going. */}
                      {(c.author === "agent" || isReply) && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            startReply(c);
                          }}
                          className="shrink-0 text-2xs text-accent-blue hover:underline opacity-70 hover:opacity-100 transition-opacity"
                          title="Reply to this comment (continues the thread)"
                          aria-label="Reply to this comment"
                        >
                          Reply
                        </button>
                      )}
                    </div>
                    {replyingTo === c.id && (
                      <div
                        className="ml-4 mt-1 pl-3 border-l-2 border-accent-blue/30"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <textarea
                          rows={2}
                          autoFocus
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              submitReply(c);
                            }
                            if (e.key === "Escape") {
                              cancelReply();
                            }
                          }}
                          placeholder="Reply to the agent… (⌘⏎ to send, Esc to cancel)"
                          disabled={replySubmitting}
                          className="w-full px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                                     placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue resize-none"
                        />
                        <div className="flex gap-1.5 mt-1">
                          <button
                            type="button"
                            onClick={() => submitReply(c)}
                            disabled={!replyText.trim() || replySubmitting}
                            className="px-2.5 py-1 bg-accent-blue text-white text-2xs rounded
                                       hover:bg-accent-blue/80 disabled:bg-surface-elevated disabled:text-text-muted transition-colors"
                          >
                            Reply
                          </button>
                          <button
                            type="button"
                            onClick={cancelReply}
                            className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              };

              return (
                <div
                  className="ml-[5.5rem] mr-3 my-1 cursor-pointer"
                  onClick={() => openCommentLine(lineNum)}
                >
                  {/* Continuation markers (span comments anchored to other
                      lines) — render compact, no threading. */}
                  {continuations.map((c) => {
                    const cStart = (c.target as any).lineStart as number | undefined;
                    const cEnd = (c.target as any).lineEnd as number | undefined;
                    return (
                      <div
                        key={c.id}
                        className="flex items-center gap-2 px-3 py-0.5 text-2xs text-text-muted"
                      >
                        <span aria-hidden>↳</span>
                        <span>
                          comment from <span className="font-mono">L{cStart}</span>
                          {cEnd != null && cEnd !== cStart ? `–L${cEnd}` : ""}
                        </span>
                      </div>
                    );
                  })}
                  {/* Top-level comments + their replies, threaded.
                      All replies flatten under the top-level ancestor;
                      arbitrary depth (Q → A → follow-up → ...) renders
                      as one parent chip + a stack of nested ↳ chips. */}
                  {tops.map((parent) => {
                    const replies = repliesByTop.get(parent.id) ?? [];
                    return (
                      <div key={parent.id}>
                        {renderChip(parent, false)}
                        {replies.length > 0 && (
                          <div className="ml-4 pl-3 border-l-2 border-accent-blue/30 space-y-0.5">
                            {[...replies]
                              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                              .map((r) => renderChip(r, true))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* Inline comment input */}
            {isCommentActive && (
              <div className="ml-[5.5rem] mr-3 my-1.5">
                {/* Show existing comments in the expanded view */}
                {lineComments.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {lineComments.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-start gap-2 px-3 py-1.5 bg-accent-blue-dim/60 rounded text-xs"
                      >
                        <span className={`font-semibold shrink-0 ${c.author === "human" ? "text-accent-blue" : "text-text-muted"}`}>
                          {c.author === "human" ? "You" : "Agent"}:
                        </span>
                        <span className="text-text-secondary">{c.content}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Mode tabs + R2 span-end input */}
                <div className="flex items-center gap-1 mb-1.5">
                  <button
                    onClick={() => setMode("comment")}
                    className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors ${
                      mode === "comment" ? "bg-accent-blue-dim text-accent-blue" : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    Comment
                  </button>
                  <button
                    onClick={() => setMode("ask")}
                    className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors ${
                      mode === "ask" ? "bg-accent-violet-dim text-accent-violet" : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    Ask
                  </button>
                  <button
                    onClick={() => {
                      setMode("suggest");
                      if (!suggestionText) {
                        setSuggestionText(lines[lineNum - lineStart] ?? "");
                      }
                    }}
                    className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors ${
                      mode === "suggest" ? "bg-accent-green-dim text-accent-green" : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    Suggest
                  </button>
                  {/* R2: lineEnd selector for span comments. Hidden in
                      'suggest' mode because suggestions replace one
                      specific line; allowing a span there would change
                      semantics. */}
                  {mode !== "suggest" && (
                    <div className="ml-auto flex items-center gap-1 text-2xs text-text-muted">
                      <span>line {lineNum}</span>
                      <span aria-hidden>→</span>
                      <input
                        type="number"
                        min={lineNum}
                        max={lineStart + lines.length - 1}
                        value={activeCommentLineEnd ?? lineNum}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) setActiveCommentLineEnd(n);
                        }}
                        title={`Comment spans lines ${lineNum} through this number`}
                        aria-label="Comment end line"
                        className="w-14 px-1.5 py-0.5 rounded text-2xs bg-surface-secondary border border-border-default text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                      />
                      {(activeCommentLineEnd ?? lineNum) > lineNum && (
                        <span className="text-accent-blue">
                          ({(activeCommentLineEnd ?? lineNum) - lineNum + 1} lines)
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {mode === "suggest" ? (
                  <div className="space-y-1.5">
                    <textarea
                      value={suggestionText}
                      onChange={(e) => setSuggestionText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          handleSubmit(lineNum);
                        }
                        if (e.key === "Escape") closeCommentLine();
                      }}
                      disabled={submitting}
                      autoFocus
                      rows={3}
                      className="w-full px-2.5 py-1.5 bg-surface-secondary border border-accent-green/30 rounded text-xs text-text-primary font-mono
                                 resize-none focus:outline-none focus:ring-1 focus:ring-accent-green"
                    />
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleSubmit(lineNum)}
                        disabled={!suggestionText.trim() || submitting}
                        className="px-2.5 py-1.5 bg-accent-green text-white text-xs rounded
                                   hover:bg-accent-green/80 disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
                      >
                        Submit Suggestion
                      </button>
                      <button onClick={closeCommentLine} className="px-2 py-1.5 text-text-muted text-xs hover:text-text-secondary transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-1.5 items-end">
                    <textarea
                      rows={2}
                      placeholder={
                        mode === "ask"
                          ? "Ask the agent about this line… (⌘⏎ to send)"
                          : "Add a comment on this line… (⌘⏎ to send)"
                      }
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          handleSubmit(lineNum);
                        }
                        if (e.key === "Escape") closeCommentLine();
                      }}
                      disabled={submitting}
                      autoFocus
                      className={`flex-1 px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                                 placeholder-text-muted focus:outline-none focus:ring-1 resize-none ${
                                   mode === "ask" ? "focus:ring-accent-violet focus:border-accent-violet" : "focus:ring-accent-blue focus:border-accent-blue"
                                 }`}
                    />
                    <button
                      onClick={() => handleSubmit(lineNum)}
                      disabled={!commentText.trim() || submitting}
                      className={`px-2.5 py-1.5 text-white text-xs rounded disabled:bg-surface-elevated disabled:text-text-muted transition-all duration-[180ms] ease-out press-scale ${
                        mode === "ask" ? "bg-accent-violet hover:bg-accent-violet/80" : "bg-accent-blue hover:bg-accent-blue/80"
                      }`}
                    >
                      {mode === "ask" ? "Ask" : "Comment"}
                    </button>
                    <button onClick={closeCommentLine} className="px-2 py-1.5 text-text-muted text-xs hover:text-text-secondary transition-colors">
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
