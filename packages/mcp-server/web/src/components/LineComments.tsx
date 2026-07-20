import { useState } from "react";
import type { Comment, CommentSuggestion } from "@deeppairing/shared";
import { suggestionSummary } from "@deeppairing/shared";
import { useArtifactStore, commentPriorVersion } from "../stores/artifact";
import { isSessionLive } from "../stores/connection";
import { ReplyModeToggle, type ReplyMode } from "./ReplyModeToggle";

/**
 * Shared per-line comment surface: the hover gutter (+ comment / ? ask /
 * optional suggest), the inline composer, and the rendering of existing
 * comments + threaded replies for a single line. Extracted from
 * CommentableCode so the diff views (split + unified) can offer the SAME
 * commenting affordance without copy-pasting ~300 lines. Both CommentableCode
 * and the diff rows render this, so a comment posted from the "result" view
 * and one posted from a diff row produce an identical line target — which is
 * what lets agent replies thread back onto either surface.
 */

export type LineMode = "comment" | "suggest" | "ask";

interface LineGutterProps {
  lineNum: number;
  /** Number of existing comments anchored to this line (drives the + badge). */
  commentCount: number;
  /** Active composer state, lifted to the parent so only one line is open at a
   *  time across the whole view. */
  active: boolean;
  activeMode: LineMode;
  onOpen: (mode: LineMode) => void;
  onClose: () => void;
  /** Suggest is only meaningful where we have the full new-side line text
   *  (CommentableCode + diff context/added rows). Hidden for removed-only
   *  rows that have no new-side line. */
  className?: string;
}

/**
 * The +/?/badge gutter. Kept tiny and presentational so each view can place it
 * inside its own row layout (the diff cell, or the CommentableCode line).
 */
export function LineGutter({
  commentCount,
  active,
  activeMode,
  onOpen,
  onClose,
  className,
}: LineGutterProps) {
  const askActive = active && activeMode === "ask";
  const commentActive = active && activeMode !== "ask";
  return (
    <div className={`flex items-center justify-end gap-0.5 select-none ${className ?? ""}`}>
      <button
        onClick={() => (askActive ? onClose() : onOpen("ask"))}
        className={`w-6 h-6 flex items-center justify-center rounded text-[10px] font-semibold transition-all ${
          askActive
            ? "bg-accent-violet-strong text-white"
            // Faint at rest so it's discoverable that lines are commentable
            // (not a hover-only secret), full on hover, and revealed on keyboard
            // focus so the gutter is reachable without a mouse (U3).
            : "opacity-25 group-hover:opacity-100 focus-visible:opacity-100 bg-accent-violet-strong text-white hover:bg-accent-violet-strong-hover"
        }`}
        title="Ask the agent about this line"
        aria-label="Ask a question about this line"
      >
        ?
      </button>
      <button
        onClick={() => (commentActive ? onClose() : onOpen("comment"))}
        className={`w-6 h-6 flex items-center justify-center rounded text-[10px] transition-all ${
          commentActive || commentCount > 0
            ? "bg-accent-blue-strong text-white"
            : "opacity-25 group-hover:opacity-100 focus-visible:opacity-100 bg-accent-blue/80 text-white hover:bg-accent-blue-strong"
        }`}
        title="Add comment on this line"
        aria-label="Add a comment on this line"
      >
        {commentCount > 0 ? commentCount : "+"}
      </button>
    </div>
  );
}

interface LineCommentChipsProps {
  lineNum: number;
  comments: Comment[];
  artifactId: string;
  filePath?: string;
  /** Click on a chip stack opens the line's composer (so the user can add
   *  another comment / see the expanded view). Optional. */
  onOpenLine?: () => void;
}

/**
 * Renders the existing comments for one line: continuation markers for span
 * comments anchored elsewhere, top-level chips, and threaded replies of
 * arbitrary depth. This is the exact threading logic CommentableCode used,
 * extracted verbatim so the diff rows show the same Q→A→follow-up story.
 */
export function LineCommentChips({
  lineNum,
  comments,
  artifactId,
  filePath,
  onOpenLine,
}: LineCommentChipsProps) {
  const submitComment = useArtifactStore((s) => s.submitComment);
  const markQuestionResolved = useArtifactStore((s) => s.markQuestionResolved);
  // Bug2 — inline chips aggregate across the version chain (via the caller's
  // useChainComments), so a v1 line comment renders on v2's line N. Surface the
  // version provenance inline the same way CommentBubble does — hiding it would
  // reintroduce the exact data-loss the aggregation fixed.
  const artifacts = useArtifactStore((s) => s.artifacts);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replySubmitting, setReplySubmitting] = useState(false);
  // I4 — mirror the rail: a line reply defaults to a plain comment; flipping to
  // "Ask" sends intent:"question" so the follow-up re-opens the thread.
  const [replyMode, setReplyMode] = useState<ReplyMode>("comment");

  if (comments.length === 0) return null;

  const startReply = (parent: Comment) => {
    setReplyingTo(parent.id);
    setReplyText("");
    setReplyMode("comment");
  };
  const cancelReply = () => {
    setReplyingTo(null);
    setReplyText("");
    setReplyMode("comment");
  };
  const submitReply = async (parent: Comment) => {
    const text = replyText.trim();
    if (!text || replySubmitting) return;
    setReplySubmitting(true);
    try {
      await submitComment(
        artifactId,
        text,
        // Reply inherits the parent's target so it lands on the same line and
        // renders threaded. Strip artifactId since submitComment re-applies it.
        { ...(parent.target ?? {}), artifactId: undefined } as any,
        // parentCommentId threads it; intent:"question" (opt-in) re-flags the
        // thread as awaiting the agent.
        { parentCommentId: parent.id, ...(replyMode === "question" ? { intent: "question" as const } : {}) },
      );
      cancelReply();
    } catch {
      // UX7d — store surfaced the error toast; keep the draft for retry and
      // (via finally) re-enable the composer instead of an unhandled rejection.
    } finally {
      setReplySubmitting(false);
    }
  };

  // Partition: continuations (span overflow from other start lines) vs primary
  // chips that belong to THIS line.
  const continuations: Comment[] = [];
  const primary: Comment[] = [];
  for (const c of comments) {
    const cStart = c.target.lineStart;
    if (cStart != null && cStart !== lineNum) continuations.push(c);
    else primary.push(c);
  }

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
      if (!topIds.has(c.id)) {
        topIds.add(c.id);
        tops.push(c);
      }
    } else {
      const arr = repliesByTop.get(top.id) ?? [];
      arr.push(c);
      repliesByTop.set(top.id, arr);
      if (!topIds.has(top.id)) {
        topIds.add(top.id);
        tops.push(top);
      }
    }
  }

  const renderChip = (c: Comment, isReply: boolean) => {
    const cStart = c.target.lineStart;
    const cEnd = c.target.lineEnd;
    const spanLabel = cStart != null && cEnd != null && cStart !== cEnd ? ` (lines ${cStart}–${cEnd})` : "";
    // Turn-state surfacing (mirrors CommentThread): an unanswered human
    // QUESTION can be marked resolved by the human; a posted human comment
    // shows whether the agent has drained it (delivered vs seen), read-only.
    const isHuman = c.author === "human";
    const isQuestion = c.intent === "question";
    const answered = !!c.answeredByCommentId;
    const humanResolved = !!c.humanResolvedAt;
    const priorVersion = commentPriorVersion(artifacts, c, artifactId);
    return (
      <div key={c.id} className="mb-0.5">
        <div className="flex items-start gap-2 px-3 py-1.5 bg-accent-blue-dim/60 rounded text-xs">
          <span className={`font-semibold shrink-0 ${isHuman ? "text-accent-blue" : "text-text-muted"}`}>
            {isReply && (
              <span className="opacity-60 mr-1" aria-hidden>
                ↳
              </span>
            )}
            {isHuman ? "You" : "Agent"}
            {spanLabel}:
          </span>
          {/* Bug2 — this line comment predates the version being viewed
              (aggregated across the chain); tag it so its provenance is honest
              inline, since line N may hold different content on v2. */}
          {priorVersion != null && (
            <span
              className="shrink-0 self-center text-2xs text-text-muted/80 italic"
              title="Posted on an earlier version of this artifact"
            >
              from v{priorVersion}
            </span>
          )}
          <span className="text-text-secondary flex-1">{c.content}</span>
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
        {/* Question status: awaiting answer + a human "Mark resolved", or
            "resolved by you" once cleared. */}
        {isHuman && isQuestion && (
          <div className="flex items-center gap-2 px-3 mt-0.5 text-2xs">
            {humanResolved ? (
              <span className="text-text-muted italic">resolved by you</span>
            ) : answered ? null : (
              <>
                <span className="text-accent-violet">⏳ awaiting answer</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void markQuestionResolved(c.id).catch(() => {}); // store toasts (incl. replay refusal)
                  }}
                  className="text-text-muted hover:text-text-secondary underline-offset-2 hover:underline"
                  title="Mark this question resolved — clears it from your 'waiting' list without an agent answer"
                >
                  Mark resolved
                </button>
              </>
            )}
          </div>
        )}
        {/* Delivery visibility for plain human comments (read-only; derived
            from the agent's acknowledged drain flag — never sets it). */}
        {isHuman && !isQuestion && (
          <div className="px-3 mt-0.5 text-2xs text-text-muted">
            {c.acknowledged ? "✓ seen by agent" : isSessionLive(c.sessionId) ? "delivered · awaiting agent" : "delivered · agent exited"}
          </div>
        )}
        {replyingTo === c.id && (
          <div
            className={`ml-4 mt-1 pl-3 border-l-2 ${
              replyMode === "question" ? "border-accent-violet/40" : "border-accent-blue/30"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1">
              <ReplyModeToggle mode={replyMode} setMode={setReplyMode} />
            </div>
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
                if (e.key === "Escape") cancelReply();
              }}
              placeholder={
                replyMode === "question"
                  ? "Ask the agent a follow-up… (⌘⏎ to send, Esc to cancel)"
                  : "Reply to the agent… (⌘⏎ to send, Esc to cancel)"
              }
              disabled={replySubmitting}
              className={`w-full px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                         placeholder-text-muted focus:outline-none focus:ring-1 resize-none ${
                           replyMode === "question" ? "focus:ring-accent-violet" : "focus:ring-accent-blue"
                         }`}
            />
            <div className="flex gap-1.5 mt-1">
              <button
                type="button"
                onClick={() => submitReply(c)}
                disabled={!replyText.trim() || replySubmitting}
                className={`px-2.5 py-1 text-white text-2xs rounded disabled:bg-surface-elevated disabled:text-text-muted transition-colors ${
                  replyMode === "question"
                    ? "bg-accent-violet-strong hover:bg-accent-violet-strong-hover"
                    : "bg-accent-blue-strong hover:bg-accent-blue/80"
                }`}
              >
                {replyMode === "question" ? "Ask" : "Reply"}
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
      className={onOpenLine ? "cursor-pointer" : ""}
      onClick={onOpenLine ? () => onOpenLine() : undefined}
      data-comment-anchor={`line:${filePath ?? ""}:${lineNum}`}
    >
      {continuations.map((c) => {
        const cStart = c.target.lineStart;
        const cEnd = c.target.lineEnd;
        return (
          <div key={c.id} className="flex items-center gap-2 px-3 py-0.5 text-2xs text-text-muted">
            <span aria-hidden>↳</span>
            <span>
              comment from <span className="font-mono">L{cStart}</span>
              {cEnd != null && cEnd !== cStart ? `–L${cEnd}` : ""}
            </span>
          </div>
        );
      })}
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
}

interface LineComposerProps {
  lineNum: number;
  /** Total line count of the underlying source (for clamping span ends). When
   *  unknown (diff rows don't have a single contiguous source), pass undefined
   *  to disable the span-end UI and force single-line targeting. */
  totalLines?: number;
  /** Last line number selectable for the span end (defaults to totalLines). */
  maxLine?: number;
  artifactId: string;
  filePath?: string;
  /** The new-side source line text, used to pre-fill Suggest mode. Omit to
   *  hide the Suggest tab (e.g. a removed-only diff row has no new line). */
  lineText?: string;
  /** #172 — the full source lines + their starting line number. When present,
   *  "Suggest edit" pre-fills a CONTIGUOUS RANGE (lineNum..lineEnd), not just the
   *  single line. Diff rows omit these (no contiguous source) and fall back to
   *  the single `lineText`. */
  sourceLines?: string[];
  sourceLineStart?: number;
  mode: LineMode;
  setMode: (m: LineMode) => void;
  existingComments: Comment[];
  targetContext?: {
    findingIndex?: number;
    evidenceIndex?: number;
    stepIndex?: number;
  };
  onClose: () => void;
}

/**
 * The inline composer for one line (Comment / Ask / Suggest + span end).
 * Submits via useArtifactStore().submitComment with the SAME target shape
 * CommentableCode used, so a comment from a diff row is indistinguishable
 * from one made in the result view.
 */
export function LineComposer({
  lineNum,
  totalLines,
  maxLine,
  artifactId,
  filePath,
  lineText,
  sourceLines,
  sourceLineStart,
  mode,
  setMode,
  existingComments,
  targetContext,
  onClose,
}: LineComposerProps) {
  const submitComment = useArtifactStore((s) => s.submitComment);
  const [commentText, setCommentText] = useState("");
  const [lineEnd, setLineEnd] = useState<number>(lineNum);
  const [submitting, setSubmitting] = useState(false);

  const canSuggest = lineText != null;
  const canSpan = totalLines != null;
  const spanMax = maxLine ?? totalLines ?? lineNum;

  // #172 — the ORIGINAL text of the suggested range. When we have the full
  // source, slice the contiguous range [lineNum..suggestEnd]; otherwise (diff
  // rows) fall back to the single new-side line.
  const canRange = Array.isArray(sourceLines) && sourceLineStart != null;
  // "Suggest edit" gets its OWN range end so it can span while the range shows
  // live — independent of the comment/ask span control above.
  const [suggestEnd, setSuggestEnd] = useState<number>(lineNum);
  const rangeEnd = canRange ? Math.max(lineNum, Math.min(suggestEnd, spanMax)) : lineNum;
  const originalRange = canRange
    ? (sourceLines as string[]).slice(lineNum - (sourceLineStart as number), rangeEnd - (sourceLineStart as number) + 1).join("\n")
    : (lineText ?? "");
  // The editable replacement — pre-filled with the original range.
  const [suggestionText, setSuggestionText] = useState<string | null>(null);
  const effectiveSuggestion = suggestionText ?? originalRange;

  // Live line-level diff: which editor lines differ from the original range.
  const originalLines = originalRange.split("\n");
  const editorLines = effectiveSuggestion.split("\n");
  const changedLine = (i: number): boolean => editorLines[i] !== (originalLines[i] ?? undefined);

  const handleSubmit = async () => {
    if (submitting) return;
    const rawEnd = canSpan ? lineEnd : lineNum;
    const safeEnd = Math.max(lineNum, Math.min(rawEnd, spanMax));
    if (mode === "suggest" ? !effectiveSuggestion.trim() : !commentText.trim()) return;

    // UX7d — wrap in try/catch/finally: pre-fix a thrown submitComment left
    // `submitting` true forever (composer permanently disabled) and skipped
    // onClose. Now we always re-enable, only close on success, and keep the
    // typed text on failure (the store rolls back + toasts + re-throws).
    setSubmitting(true);
    try {
      if (mode === "suggest") {
        // #172 — a first-class suggested edit. content = the "why" note, or the
        // shared summary when blank (the ledger uses that same summary to tell a
        // genuine why from the fallback). The #187 hazard: `submitComment`'s 4th
        // arg is an OPTIONS object, never a MouseEvent — handleSubmit takes no
        // event, so the tab/footer onClick wrappers can't leak one in.
        const suggestion: CommentSuggestion = {
          originalText: originalRange,
          replacementText: effectiveSuggestion,
          lineStart: lineNum,
          lineEnd: rangeEnd,
          state: "pending",
        };
        const why = commentText.trim();
        const content = why || suggestionSummary(filePath, lineNum, rangeEnd);
        await submitComment(
          artifactId,
          content,
          { lineStart: lineNum, lineEnd: rangeEnd, filePath, ...targetContext },
          { intent: "suggestion", suggestion },
        );
      } else {
        await submitComment(
          artifactId,
          commentText.trim(),
          { lineStart: lineNum, lineEnd: safeEnd, filePath, ...targetContext },
          mode === "ask" ? { intent: "question" } : undefined,
        );
      }
      onClose();
    } catch {
      /* store surfaced the error toast; keep the composer open + text for retry */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ml-[5.5rem] mr-3 my-1.5">
      {existingComments.length > 0 && (
        <div className="mb-2 space-y-1">
          {existingComments.map((c) => (
            <div key={c.id} className="flex items-start gap-2 px-3 py-1.5 bg-accent-blue-dim/60 rounded text-xs">
              <span className={`font-semibold shrink-0 ${c.author === "human" ? "text-accent-blue" : "text-text-muted"}`}>
                {c.author === "human" ? "You" : "Agent"}:
              </span>
              <span className="text-text-secondary">{c.content}</span>
            </div>
          ))}
        </div>
      )}

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
        {canSuggest && (
          <button
            onClick={() => setMode("suggest")}
            className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors ${
              mode === "suggest" ? "bg-accent-green-dim text-accent-green" : "text-text-muted hover:text-text-secondary"
            }`}
          >
            Suggest edit
          </button>
        )}
        {mode !== "suggest" && canSpan && (
          <div className="ml-auto flex items-center gap-1 text-2xs text-text-muted">
            <span>line {lineNum}</span>
            <span aria-hidden>→</span>
            <input
              type="number"
              min={lineNum}
              max={spanMax}
              value={lineEnd}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setLineEnd(n);
              }}
              title={`Comment spans lines ${lineNum} through this number`}
              aria-label="Comment end line"
              className="w-14 px-1.5 py-0.5 rounded text-2xs bg-surface-secondary border border-border-default text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
            />
            {lineEnd > lineNum && <span className="text-accent-blue">({lineEnd - lineNum + 1} lines)</span>}
          </div>
        )}
      </div>

      {mode === "suggest" ? (
        <div className="space-y-1.5" data-testid="suggest-edit-composer">
          {/* Which lines you're editing (+ optional range extension). */}
          <p className="text-2xs text-text-muted">
            Editing lines{" "}
            <span className="text-text-secondary font-medium">
              {lineNum}
              {rangeEnd > lineNum ? `–${rangeEnd}` : ""}
            </span>{" "}
            — your version replaces them if Claude accepts.
            {canRange && spanMax > lineNum && (
              <span className="ml-1.5 inline-flex items-center gap-1">
                <span aria-hidden>·</span>
                <span>to</span>
                <input
                  type="number"
                  min={lineNum}
                  max={spanMax}
                  value={suggestEnd}
                  onChange={(e) => {
                    // While the editor is still the untouched pre-fill
                    // (suggestionText == null), effectiveSuggestion tracks the
                    // range automatically via originalRange.
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) setSuggestEnd(n);
                  }}
                  aria-label="Last line to suggest an edit for"
                  className="w-14 px-1.5 py-0.5 rounded text-2xs bg-surface-secondary border border-border-default text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-green"
                />
              </span>
            )}
          </p>
          {/* Mono mini-editor, pre-filled with the selected lines. */}
          <textarea
            data-testid="suggestion-editor"
            aria-label="Suggested replacement code"
            value={effectiveSuggestion}
            onChange={(e) => setSuggestionText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
              if (e.key === "Escape") onClose();
            }}
            disabled={submitting}
            autoFocus
            rows={Math.min(Math.max(editorLines.length, 3), 12)}
            spellCheck={false}
            className="w-full px-2.5 py-1.5 bg-surface-primary border border-border-default rounded text-xs text-text-primary font-mono
                       resize-y focus:outline-none focus:ring-1 focus:ring-accent-green whitespace-pre overflow-x-auto"
          />
          {/* Live changed-line highlight (line-level diff vs original). */}
          <div
            data-testid="suggestion-diff-preview"
            className="rounded border border-border-subtle bg-surface-code font-mono text-2xs leading-[18px] overflow-x-auto"
            aria-hidden
          >
            {editorLines.map((ln, i) => {
              const isChanged = changedLine(i);
              return (
                <div
                  key={i}
                  data-changed={isChanged ? "true" : "false"}
                  className={`px-2 whitespace-pre ${isChanged ? "bg-diff-add-bg text-text-primary" : "text-text-muted"}`}
                >
                  {ln || " "}
                </div>
              );
            })}
          </div>
          {/* Optional "why" note — feeds the ledger when non-empty. */}
          <textarea
            data-testid="suggestion-why"
            aria-label="Why this edit (optional)"
            rows={2}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
              if (e.key === "Escape") onClose();
            }}
            disabled={submitting}
            placeholder="(why, optional but it teaches the ledger)"
            className="w-full px-2.5 py-1.5 bg-surface-primary border border-border-subtle rounded text-xs text-text-secondary
                       placeholder-text-muted resize-none focus:outline-none focus:ring-1 focus:ring-accent-green"
          />
          {/* Footer: ⌘⏎ hint · Cancel · Suggest to Claude */}
          <div className="flex items-center gap-2">
            <span className="text-2xs text-text-muted">
              <kbd className="font-mono">⌘⏎</kbd> send
            </span>
            <span className="flex-1" />
            <button onClick={onClose} className="px-2.5 py-1.5 text-text-muted text-xs hover:text-text-secondary transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!effectiveSuggestion.trim() || submitting}
              className="px-2.5 py-1.5 bg-accent-green text-white text-xs rounded
                         hover:bg-accent-green/80 disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
            >
              Suggest to Claude
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
                handleSubmit();
              }
              if (e.key === "Escape") onClose();
            }}
            disabled={submitting}
            autoFocus
            className={`flex-1 px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                       placeholder-text-muted focus:outline-none focus:ring-1 resize-none ${
                         mode === "ask"
                           ? "focus:ring-accent-violet focus:border-accent-violet"
                           : "focus:ring-accent-blue focus:border-accent-blue"
                       }`}
          />
          <button
            onClick={handleSubmit}
            disabled={!commentText.trim() || submitting}
            className={`px-2.5 py-1.5 text-white text-xs rounded disabled:bg-surface-elevated disabled:text-text-muted transition-all duration-[180ms] ease-out press-scale ${
              mode === "ask" ? "bg-accent-violet-strong hover:bg-accent-violet-strong-hover" : "bg-accent-blue-strong hover:bg-accent-blue/80"
            }`}
          >
            {mode === "ask" ? "Ask" : "Comment"}
          </button>
          <button onClick={onClose} className="px-2 py-1.5 text-text-muted text-xs hover:text-text-secondary transition-colors">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
