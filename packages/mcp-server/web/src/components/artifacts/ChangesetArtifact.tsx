import { useMemo, useState } from "react";
import type { Artifact, Comment, ChangesetFile } from "@deeppairing/shared";
import { coerceChangesetContent } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useReplayStore } from "../../stores/replay";
import { useChainComments } from "../../hooks/useChainComments";
import { OpenInEditorLink } from "../OpenInEditor";
import { LineGutter, LineCommentChips, LineComposer, type LineMode } from "../LineComments";

/**
 * #171 — ChangesetArtifact: a change spanning 2+ files reviewed as ONE unit.
 *
 * Layout mirrors the approved mockup: a summary strip (file count, +/−,
 * risk chips, review-progress note), a left file rail (M/A/D marks, diffstat
 * bars, per-file state, the cross-file comment card), and a unified-diff pane
 * with the EXISTING per-line comment machinery (LineGutter/LineComposer/
 * LineCommentChips), plus per-file "File looks right" / "Skip for now" and a
 * whole-changeset action bar (Approve disabled until every file is
 * reviewed-or-skipped).
 */

const changeMark: Record<ChangesetFile["changeType"], { letter: string; cls: string; label: string }> = {
  modified: { letter: "M", cls: "text-accent-amber", label: "modified" },
  added: { letter: "A", cls: "text-accent-green", label: "added" },
  deleted: { letter: "D", cls: "text-accent-red", label: "deleted" },
};

/** Derive a file's add/del tally from its hunks when the agent didn't supply
 *  `stats` (all new fields optional). */
function fileStats(file: ChangesetFile): { additions: number; deletions: number } {
  if (file.stats) return file.stats;
  let additions = 0;
  let deletions = 0;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") additions++;
      else if (l.kind === "del") deletions++;
    }
  }
  return { additions, deletions };
}

/** A 5-segment diffstat bar, proportionally green (adds) / red (dels). */
function StatBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const segs = 5;
  const green = total === 0 ? 0 : Math.round((additions / total) * segs);
  const red = total === 0 ? 0 : Math.min(segs - green, Math.ceil((deletions / total) * segs));
  const cells: ("g" | "r" | "")[] = [];
  for (let i = 0; i < segs; i++) cells.push(i < green ? "g" : i < green + red ? "r" : "");
  return (
    <span className="inline-flex gap-px shrink-0" aria-hidden>
      {cells.map((c, i) => (
        <i
          key={i}
          className={`w-[5px] h-2 rounded-[1px] inline-block ${
            c === "g" ? "bg-accent-green" : c === "r" ? "bg-accent-red" : "bg-border-default"
          }`}
        />
      ))}
    </span>
  );
}

export function ChangesetArtifact({ artifact }: { artifact: Artifact }) {
  const content = coerceChangesetContent(artifact.content);
  const files = content.files;
  const reviewState = content.reviewState ?? {};

  const setChangesetFileReview = useArtifactStore((s) => s.setChangesetFileReview);
  const updateArtifactStatus = useArtifactStore((s) => s.updateArtifactStatus);
  const replayActive = useReplayStore((s) => s.active);
  const interactive = artifact.status === "draft" && !replayActive;

  const [activeIdx, setActiveIdx] = useState(0);
  const activeFile = files[Math.min(activeIdx, Math.max(0, files.length - 1))];

  // Comments across the version chain (v1 comments render on v2).
  const allComments = useChainComments(artifact.id);

  // Cross-file threads: a comment carrying 2+ anchors binds locations across
  // files — the thing single-file review can't say.
  const crossFileComments = useMemo(
    () => allComments.filter((c) => Array.isArray(c.target.anchors) && c.target.anchors.length >= 2),
    [allComments],
  );

  // Per-file line comments for the ACTIVE file, bucketed by the new-side line
  // (a comment made on an add/context row targets its newLine — byte-identical
  // to a code_change line comment, so agent replies thread on either surface).
  const activeCommentsByLine = useMemo(() => {
    const map = new Map<number, Comment[]>();
    if (!activeFile) return map;
    for (const c of allComments) {
      const t = c.target;
      if (t.filePath !== activeFile.path || t.lineStart == null) continue;
      const start = Math.max(0, Math.floor(Number(t.lineStart)));
      const end = t.lineEnd == null ? start : Math.max(start, Math.floor(Number(t.lineEnd)));
      const safeEnd = Math.min(end, start + 200);
      for (let line = start; line <= safeEnd; line++) {
        const existing = map.get(line) ?? [];
        existing.push(c);
        map.set(line, existing);
      }
    }
    return map;
  }, [allComments, activeFile]);

  // Cross-file anchor chips keyed by line on the active file.
  const crossFileAnchorsByLine = useMemo(() => {
    const map = new Map<number, Comment[]>();
    if (!activeFile) return map;
    for (const c of crossFileComments) {
      for (const a of c.target.anchors ?? []) {
        if (a.filePath !== activeFile.path) continue;
        const line = Math.floor(Number(a.lineStart));
        if (!Number.isFinite(line)) continue;
        const existing = map.get(line) ?? [];
        existing.push(c);
        map.set(line, existing);
      }
    }
    return map;
  }, [crossFileComments, activeFile]);

  // Per-file "open comment" counts (any line comment on that file).
  const commentCountByFile = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of allComments) {
      const fp = c.target.filePath;
      if (fp && c.target.lineStart != null) counts[fp] = (counts[fp] ?? 0) + 1;
    }
    return counts;
  }, [allComments]);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      const s = fileStats(f);
      additions += s.additions;
      deletions += s.deletions;
    }
    return { additions, deletions };
  }, [files]);

  const isDone = (path: string) => reviewState[path] === "reviewed" || reviewState[path] === "skipped";
  const filesLeft = files.filter((f) => !isDone(f.path)).length;
  const reviewedCount = files.length - filesLeft;
  const allReviewed = filesLeft === 0 && files.length > 0;

  // One open composer at a time across the active file's diff.
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [mode, setMode] = useState<LineMode>("comment");

  // Whole-changeset action state.
  const [reviewAction, setReviewAction] = useState<"none" | "reject" | "revise">("none");
  const [feedback, setFeedback] = useState("");
  const [rejectConcept, setRejectConcept] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const toggleFileReview = async (path: string) => {
    const next = reviewState[path] === "reviewed" ? null : "reviewed";
    try {
      await setChangesetFileReview(artifact.id, path, next);
    } catch {
      /* store toasted + rolled back */
    }
  };
  const skipFile = async (path: string) => {
    const next = reviewState[path] === "skipped" ? null : "skipped";
    try {
      await setChangesetFileReview(artifact.id, path, next);
    } catch {
      /* store toasted + rolled back */
    }
  };

  const runWhole = async (status: "approved" | "revised" | "rejected") => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const trimmed = feedback.trim();
      const concept = status === "rejected" ? rejectConcept.trim() || undefined : undefined;
      await updateArtifactStatus(artifact.id, status, trimmed || undefined, concept);
      setReviewAction("none");
      setFeedback("");
      setRejectConcept("");
    } catch {
      /* store toasted + rolled back */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Summary strip */}
      <div
        className="flex items-center gap-4 flex-wrap px-3 py-2 bg-surface-secondary border border-border-subtle rounded text-xs text-text-secondary"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        <span>
          <b className="text-text-primary">{files.length} file{files.length === 1 ? "" : "s"}</b>
        </span>
        <span>
          <span className="text-accent-green font-semibold">+{totals.additions}</span>{" "}
          <span className="text-accent-red font-semibold">−{totals.deletions}</span>
        </span>
        {content.risks && content.risks.length > 0 && (
          <span className="flex items-center gap-1.5">
            {content.risks.map((r) => (
              <span
                key={r}
                className="inline-flex items-center gap-1 text-2xs font-bold tracking-wide uppercase text-accent-amber bg-accent-amber-dim rounded px-1.5 py-0.5"
              >
                ⚠ {r}
              </span>
            ))}
          </span>
        )}
        <span className="ml-auto text-2xs text-text-muted">
          <b className="text-accent-green">{reviewedCount} of {files.length} files reviewed</b>
          {" — "}approval unlocks when every file is reviewed
        </span>
      </div>

      {/* Rail + diff */}
      <div className="grid grid-cols-1 min-[820px]:grid-cols-[240px_1fr] gap-3">
        {/* File rail */}
        <div className="border border-border-subtle rounded bg-surface-secondary py-2 self-start">
          <div className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-text-muted">
            Changed files
          </div>
          <ul>
            {files.map((f, i) => {
              const mark = changeMark[f.changeType];
              const s = fileStats(f);
              const done = reviewState[f.path];
              const openComments = commentCountByFile[f.path] ?? 0;
              const isActive = i === activeIdx;
              return (
                <li key={`${f.path}-${i}`}>
                  <button
                    type="button"
                    onClick={() => { setActiveIdx(i); setActiveLine(null); }}
                    aria-current={isActive ? "true" : undefined}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 font-mono text-[11.5px] border-l-2 text-left ${
                      isActive
                        ? "bg-surface-active border-accent-blue text-text-primary"
                        : "border-transparent text-text-secondary hover:bg-surface-hover"
                    }`}
                    title={`${mark.label} ${f.path}`}
                  >
                    <span className={`w-3 text-center font-bold text-2xs shrink-0 ${mark.cls}`} aria-label={mark.label}>
                      {mark.letter}
                    </span>
                    <span className="flex-1 min-w-0 truncate">{f.path}</span>
                    <StatBar additions={s.additions} deletions={s.deletions} />
                    {done === "reviewed" ? (
                      <span className="shrink-0 text-2xs text-accent-green font-sans" title="Reviewed">✓</span>
                    ) : done === "skipped" ? (
                      <span className="shrink-0 text-2xs text-text-muted font-sans" title="Skipped">skip</span>
                    ) : openComments > 0 ? (
                      <span className="shrink-0 text-2xs text-accent-blue font-sans font-bold" title={`${openComments} comment${openComments === 1 ? "" : "s"}`}>●{openComments}</span>
                    ) : (
                      <span className="shrink-0 text-2xs text-text-muted font-sans" title="Untouched">—</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Cross-file comment cards */}
          {crossFileComments.map((c) => (
            <div
              key={c.id}
              className="mx-2 mt-2.5 p-2 bg-accent-blue-dim border border-border-focus rounded text-2xs text-text-secondary leading-snug"
            >
              <div className="text-2xs font-bold tracking-wide text-accent-blue mb-0.5">CROSS-FILE COMMENT</div>
              <div>{c.content}</div>
              <div className="font-mono text-[10.5px] text-text-primary mt-1">
                {(c.target.anchors ?? []).map((a, i) => (
                  <span key={`${a.filePath}-${a.lineStart}`}>
                    {i > 0 ? " ↔ " : ""}
                    {a.filePath}:{a.lineStart}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Diff pane for the active file */}
        <div className="min-w-0 border border-border-subtle rounded overflow-hidden bg-surface-primary">
          {activeFile ? (
            <>
              {/* File header + per-file actions */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle font-mono text-xs bg-surface-primary flex-wrap">
                <span className={`font-bold text-2xs ${changeMark[activeFile.changeType].cls}`}>
                  {changeMark[activeFile.changeType].letter}
                </span>
                <span className="text-text-primary">{activeFile.path}</span>
                <OpenInEditorLink filePath={activeFile.path} line={1} />
                {(() => {
                  const s = fileStats(activeFile);
                  return (
                    <span className="text-2xs text-text-muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                      <span className="text-accent-green">+{s.additions}</span>{" "}
                      <span className="text-accent-red">−{s.deletions}</span>
                    </span>
                  );
                })()}
                {interactive && (
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => toggleFileReview(activeFile.path)}
                      aria-pressed={reviewState[activeFile.path] === "reviewed"}
                      className={`px-2 py-1 text-2xs font-semibold rounded border transition-colors ${
                        reviewState[activeFile.path] === "reviewed"
                          ? "text-accent-green border-accent-green/40 bg-accent-green-dim"
                          : "text-accent-green border-accent-green/30 hover:bg-accent-green-dim"
                      }`}
                      title="Mark this file reviewed (review progress — reversible, not a decision)"
                    >
                      ✓ File looks right
                    </button>
                    <button
                      type="button"
                      onClick={() => skipFile(activeFile.path)}
                      aria-pressed={reviewState[activeFile.path] === "skipped"}
                      className={`px-2 py-1 text-2xs font-semibold rounded border transition-colors ${
                        reviewState[activeFile.path] === "skipped"
                          ? "text-text-primary border-border-default bg-surface-active"
                          : "text-text-secondary border-border-default hover:bg-surface-hover"
                      }`}
                      title="Skip this file for now (counts toward review so approval can unlock)"
                    >
                      Skip for now
                    </button>
                  </div>
                )}
              </div>

              {/* Unified diff hunks */}
              <div className="font-mono text-[13px] leading-[20px] bg-surface-primary">
                {activeFile.hunks.length === 0 && (
                  <div className="px-3 py-2 text-2xs text-text-muted italic">No diff hunks for this file.</div>
                )}
                {activeFile.hunks.map((hunk, hi) => (
                  <div key={hi}>
                    {hunk.header && (
                      <div className="font-mono text-2xs text-accent-cyan bg-surface-code px-3 py-1 border-y border-border-subtle whitespace-pre-wrap break-words">
                        {hunk.header}
                      </div>
                    )}
                    {hunk.lines.map((line, li) => {
                      const newLine = line.newLine ?? null;
                      // FOLLOW-UP (#171): line comments anchor to the NEW-side
                      // line only, so a purely-DELETED line (no newLine) isn't
                      // commentable — a reviewer can't yet anchor "why did you
                      // remove this?" on a del row, and a fully-deleted file has
                      // zero commentable lines. Fixing it needs a `side`
                      // discriminator on the comment anchor (old/new numbers
                      // overlap in a diff, so they'd collide without it), which
                      // cross-cuts the SHARED LineComposer/LineCommentChips
                      // (also used by code_change) + comment-read keying +
                      // check_feedback delivery — deferred to keep that shared
                      // machinery stable. Same new-side-only behavior as
                      // CodeChangeArtifact's diff views.
                      const commentable = interactive && newLine != null;
                      const lineComments = newLine != null ? activeCommentsByLine.get(newLine) ?? [] : [];
                      const xfileChips = newLine != null ? crossFileAnchorsByLine.get(newLine) ?? [] : [];
                      const isActive = commentable && activeLine === newLine;
                      return (
                        <div key={`${hi}-${li}`} data-comment-anchor={newLine != null ? `line:${activeFile.path}:${newLine}` : undefined}>
                          <div
                            className={`flex group ${
                              line.kind === "del"
                                ? "bg-accent-red-dim/30"
                                : line.kind === "add"
                                  ? "bg-accent-green-dim/30"
                                  : ""
                            }`}
                          >
                            {commentable ? (
                              <LineGutter
                                lineNum={newLine!}
                                commentCount={lineComments.length}
                                active={isActive}
                                activeMode={mode}
                                onOpen={(m) => { setActiveLine(newLine!); setMode(m); }}
                                onClose={() => setActiveLine(null)}
                                className="w-10 shrink-0 pr-0.5"
                              />
                            ) : (
                              <span className="w-10 shrink-0" />
                            )}
                            {/* Old line number */}
                            <span className="w-8 shrink-0 text-right pr-1 py-0.5 text-2xs text-text-muted select-none">
                              {line.oldLine ?? ""}
                            </span>
                            {/* New line number */}
                            <span className="w-8 shrink-0 text-right pr-2 py-0.5 text-2xs text-text-muted select-none border-r border-border-subtle">
                              {line.newLine ?? ""}
                            </span>
                            {/* Sign */}
                            <span className={`w-5 shrink-0 text-center py-0.5 select-none font-bold ${
                              line.kind === "del" ? "text-accent-red" : line.kind === "add" ? "text-accent-green" : "text-text-muted"
                            }`}>
                              {line.kind === "del" ? "−" : line.kind === "add" ? "+" : " "}
                            </span>
                            {/* Content — like the mockup, add/del code is
                                text-primary (only the sign is colored) so it
                                stays high-contrast in both themes. Long lines
                                WRAP (whitespace-pre-wrap + break-words) rather
                                than horizontal-scroll — a per-line scroll region
                                isn't keyboard-focusable (axe
                                scrollable-region-focusable), and wrapping is
                                mobile-safe. */}
                            <span className={`px-2 py-0.5 whitespace-pre-wrap break-words flex-1 min-w-0 ${
                              line.kind === "ctx" ? "text-text-secondary" : "text-text-primary"
                            }`}>
                              {line.content || " "}
                            </span>
                            {xfileChips.length > 0 && (
                              <span
                                className="shrink-0 self-center mr-2 inline-flex items-center gap-1 text-2xs font-bold text-accent-blue bg-accent-blue-dim rounded px-1.5 py-0.5 font-mono"
                                title="Part of a cross-file comment thread"
                              >
                                ↔ cross-file
                              </span>
                            )}
                          </div>

                          {/* Existing line comments (+ threaded replies). */}
                          {commentable && lineComments.length > 0 && !isActive && (
                            <div className="ml-[5.5rem] mr-3 my-1">
                              <LineCommentChips
                                lineNum={newLine!}
                                comments={lineComments}
                                artifactId={artifact.id}
                                filePath={activeFile.path}
                                onOpenLine={() => { setActiveLine(newLine!); setMode("comment"); }}
                              />
                            </div>
                          )}

                          {/* Inline composer — single-line targeting; filePath
                              carries the changeset file dimension. */}
                          {isActive && (
                            <LineComposer
                              lineNum={newLine!}
                              artifactId={artifact.id}
                              filePath={activeFile.path}
                              lineText={line.content}
                              mode={mode}
                              setMode={setMode}
                              existingComments={lineComments}
                              onClose={() => setActiveLine(null)}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="px-3 py-4 text-xs text-text-muted">This changeset has no files.</div>
          )}
        </div>
      </div>

      {/* Whole-changeset action bar (draft + non-replay only) */}
      {interactive && (
        <div className="space-y-2 pt-2 border-t border-border-default">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xs text-text-muted mr-auto max-w-[46ch]">
              Rejecting the changeset records the <b className="text-text-secondary">approach</b> in your ledger — the gate will pause a re-attempt.
            </span>
            <button
              type="button"
              onClick={() => { setReviewAction(reviewAction === "reject" ? "none" : "reject"); setRejectConcept((artifact.content as { concept?: { name?: string } } | null)?.concept?.name ?? ""); }}
              disabled={submitting}
              className="px-2.5 py-1 text-2xs font-semibold text-accent-red rounded border border-accent-red/30 hover:bg-accent-red-dim disabled:opacity-50 transition-colors"
            >
              ✕ Reject approach
            </button>
            <button
              type="button"
              onClick={() => setReviewAction(reviewAction === "revise" ? "none" : "revise")}
              disabled={submitting}
              className="px-2.5 py-1 text-2xs font-semibold text-accent-amber rounded border border-accent-amber/30 hover:bg-accent-amber-dim disabled:opacity-50 transition-colors"
            >
              ↻ Request revision
            </button>
            <button
              type="button"
              onClick={() => runWhole("approved")}
              disabled={!allReviewed || submitting}
              aria-disabled={!allReviewed || submitting}
              title={allReviewed ? "Approve the whole changeset" : `Review or skip every file first (${filesLeft} left)`}
              className="px-3 py-1.5 text-xs font-medium text-white bg-accent-blue-strong rounded hover:bg-accent-blue-strong-hover disabled:opacity-55 disabled:cursor-not-allowed transition-colors"
            >
              {allReviewed ? "Approve changeset" : `Approve changeset (${filesLeft} file${filesLeft === 1 ? "" : "s"} left)`}
            </button>
          </div>

          {reviewAction === "revise" && (
            <div className="space-y-1.5 p-2.5 rounded border border-accent-amber/30 bg-accent-amber-dim/15">
              <label htmlFor="cs-revise" className="block text-2xs font-medium text-text-secondary">
                What should change? The agent will redraft the changeset.
              </label>
              <textarea
                id="cs-revise"
                autoFocus
                rows={2}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                className="w-full px-2 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-amber resize-none"
                placeholder="e.g. keep the sliding window, but don't clear the cookie on expiry"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => runWhole("revised")}
                  disabled={submitting || !feedback.trim()}
                  className="px-2.5 py-1 text-2xs font-medium text-white bg-accent-amber rounded hover:bg-accent-amber/80 disabled:opacity-50 transition-colors"
                >
                  Request revision
                </button>
                <button type="button" onClick={() => setReviewAction("none")} className="text-2xs text-text-muted hover:text-text-secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {reviewAction === "reject" && (
            <div className="space-y-1.5 p-2.5 rounded border border-accent-red/30 bg-accent-red-dim/15">
              <label htmlFor="cs-reject-concept" className="block text-2xs font-medium text-text-secondary">
                What approach are you rejecting?{" "}
                <span className="font-normal text-text-muted">This becomes your cross-project memory key — so the agent can’t paraphrase past it later.</span>
              </label>
              <input
                id="cs-reject-concept"
                autoFocus
                value={rejectConcept}
                onChange={(e) => setRejectConcept(e.target.value)}
                placeholder="e.g. “TTL refresh in the routes”"
                className="w-full px-2 py-1 bg-surface-secondary border border-border-default rounded text-xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-red"
              />
              <textarea
                rows={2}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                className="w-full px-2 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-red resize-none"
                placeholder="Why are you rejecting this approach? (remembered across sessions)"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => runWhole("rejected")}
                  disabled={submitting || !feedback.trim()}
                  className="px-2.5 py-1 text-2xs font-medium text-white bg-accent-red rounded hover:bg-accent-red/80 disabled:opacity-50 transition-colors"
                  title="Reject and remember this approach across every project"
                >
                  Reject &amp; remember
                </button>
                <button type="button" onClick={() => setReviewAction("none")} className="text-2xs text-text-muted hover:text-text-secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
