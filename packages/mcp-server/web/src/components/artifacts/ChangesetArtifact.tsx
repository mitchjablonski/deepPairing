import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, Comment, ChangesetFile } from "@deeppairing/shared";
import {
  coerceChangesetContent,
  composeSendBackFeedback,
  deriveChangesetDisposition,
  type ChangesetDisposition,
} from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useReplayStore } from "../../stores/replay";
import { useOverlayStore } from "../../stores/overlay";
import { useChainComments } from "../../hooks/useChainComments";
import { useConfirmCountdown } from "../../hooks/useConfirmCountdown";
import { computePending } from "../../lib/pending";
import { resolveChangesetKey, type ChangesetIntent } from "../../lib/changesetKeymap";
import { reviewLifecycle } from "../../lib/reviewLifecycle";
import {
  summarizeOpenSuggestions,
  describeOpenStates,
  openSuggestionsConfirmLabel,
} from "../../lib/openSuggestions";
import { OpenInEditorLink } from "../OpenInEditor";
import { LineGutter, LineComposer, type LineMode } from "../LineComments";
import { SuggestionLineFeedback } from "../SuggestionLineFeedback";
import { WalkMeThroughButton, hunkLineRange } from "../WalkMeThrough";

/**
 * #171 / #175 — ChangesetArtifact: a change spanning 2+ files reviewed as ONE
 * unit, refined per the #175 approve-ergonomics mockup.
 *
 * Each file carries a DISPOSITION — "Looks right" (✓) or "Needs changes" (↻,
 * captures a reason) — shown as a chip in the rail. The whole-changeset action
 * DERIVES from the file states: all look-right → Approve; any flagged → Send
 * back N (only the flagged files, with their reasons, via the existing
 * revise/status machinery → the agent redrafts to v2). An "Approve all N files"
 * fast path is one click for the confident glance; the file-by-file path stays.
 *
 * Keyboard-first (routed through the ONE central keymap, lib/changesetKeymap.ts,
 * live only while the changeset is focused): a=looks-right+advance, r=needs-
 * changes (focus reason), j/k=next/prev file, ⏎=fire the derived action,
 * ⇧⏎=approve-all. Reaching all-look-right ARMS the same confirm-countdown the
 * single-artifact approve uses (never a silent hard-commit). Terminal actions
 * auto-advance to the next pending artifact (computePending) — send-back
 * advances AFTER its feedback posts so it never yanks focus out of a textarea.
 */

/** #186 — the side-qualified bucket key for a changeset line comment. old-26 and
 *  new-26 are different lines in one file, so their comments must never share a
 *  bucket. Kept in ONE place so bucketing, lookup, and the composer agree. */
function sideLineKey(side: "old" | "new", line: number): string {
  return `${side}:${line}`;
}

// F2 (#202) — the changeset's former local `ChangesetLineFeedback` now shares
// the extracted `SuggestionLineFeedback` with CodeChangeArtifact; the only
// changeset-specific input, the del-side (#186) `side`, is a prop there. Render
// is byte-identical.

const changeMark: Record<ChangesetFile["changeType"], { letter: string; cls: string; label: string }> = {
  modified: { letter: "M", cls: "text-accent-amber", label: "modified" },
  added: { letter: "A", cls: "text-accent-green", label: "added" },
  deleted: { letter: "D", cls: "text-accent-red", label: "deleted" },
};

/**
 * P2 review F3 — the file path in the one-row header, WITHOUT losing the
 * filename. A plain `truncate` ellipsizes from the right, so P2's single-row fix
 * turned a deep path into "packages/mcp-server/src…" — the file actually being
 * reviewed became invisible without hovering. Split the path: the DIRECTORY
 * ellipsizes (it is the disposable half), the BASENAME never shrinks.
 */
function FilePathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  const dir = cut >= 0 ? path.slice(0, cut + 1) : "";
  const base = cut >= 0 ? path.slice(cut + 1) : path;
  return (
    <span className="flex min-w-0 items-baseline" title={path} data-testid="changeset-file-path">
      {dir && <span className="min-w-0 truncate text-text-muted">{dir}</span>}
      <span className="shrink-0 text-text-primary" data-testid="changeset-file-basename">{base}</span>
    </span>
  );
}

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

/** The rail chip for a file's derived disposition. */
function DispChip({ disposition }: { disposition: ChangesetDisposition }) {
  if (disposition === "reviewed") {
    return (
      <span className="shrink-0 text-2xs font-bold font-sans rounded-full px-1.5 py-0.5 text-accent-green bg-accent-green-dim" title="Looks right">
        ✓ ok
      </span>
    );
  }
  if (disposition === "needs_changes") {
    return (
      <span className="shrink-0 text-2xs font-bold font-sans rounded-full px-1.5 py-0.5 text-accent-amber bg-accent-amber-dim" title="Needs changes">
        ↻ changes
      </span>
    );
  }
  return (
    // #187 — muted on bg-surface-active is 4.16:1 (below AA); surface-elevated
    // clears AA for muted text (same combo as the decision "Not chosen" chip).
    // Surfaced by the approved-changeset a11y scan, where every file reads
    // "pending" (no persisted reviewState), so the chip is on screen for real.
    <span className="shrink-0 text-2xs font-bold font-sans rounded-full px-1.5 py-0.5 text-text-muted bg-surface-elevated" title="Not reviewed yet">
      — review
    </span>
  );
}

export function ChangesetArtifact({ artifact }: { artifact: Artifact }) {
  const content = useMemo(() => coerceChangesetContent(artifact.content), [artifact.content]);
  const files = content.files;
  const reviewState = useMemo(() => content.reviewState ?? {}, [content]);
  const reviewReasons = useMemo(() => content.reviewReasons ?? {}, [content]);

  const setChangesetFileReview = useArtifactStore((s) => s.setChangesetFileReview);
  const updateArtifactStatus = useArtifactStore((s) => s.updateArtifactStatus);
  const selectedArtifactId = useArtifactStore((s) => s.selectedArtifactId);
  const replayActive = useReplayStore((s) => s.active);
  // #187 — the single `interactive` gate split in two, so late COMMENTING can be
  // unlocked on a closed changeset WITHOUT reopening its review.
  //   reviewActive     — the OPEN review: per-file Looks-right/Needs-changes, the
  //                      derived Approve/Send-back bar, the review keyboard keys,
  //                      and Suggest-edit. Draft only.
  //   commentsUnlocked — line gutters / composers / threads (incl. #186's del
  //                      side). Draft OR approved (isLateCommentableStatus): an
  //                      approved changeset keeps its review-closed visual state
  //                      but accepts late follow-up comments as NEW INPUT.
  // REPLAY locks BOTH (replayActive is an unconditional freeze, unchanged).
  // #189 — the tuple is derived from ONE shared write-axis helper now
  // (reviewLifecycle). Behavior is byte-identical to the inline booleans:
  //   review    → reviewActive + commentsUnlocked        (draft, live)
  //   follow_up → commentsUnlocked only                  (late-commentable, live)
  //   frozen    → neither                                (replay)
  //   closed    → neither                                (terminal, live)
  const lifecycle = reviewLifecycle(artifact.status, replayActive);
  const reviewActive = lifecycle === "review";
  const commentsUnlocked = lifecycle === "review" || lifecycle === "follow_up";
  // True only in the late lane (commenting on, review off) — drives the honesty
  // marker + the withholding of Suggest-edit in the composer.
  const followUpLane = lifecycle === "follow_up";
  const isFocused = selectedArtifactId === artifact.id;

  const [activeIdx, setActiveIdx] = useState(0);
  const clampedIdx = Math.min(activeIdx, Math.max(0, files.length - 1));
  const activeFile = files[clampedIdx];

  // "Review all" — stack every file's diff in one scroll (vs. file-by-file rail nav).
  const [reviewAll, setReviewAll] = useState(false);

  // Comments across the version chain (v1 comments render on v2).
  const allComments = useChainComments(artifact.id);

  // H1/M1 (#202) — open (pending/countered) suggestions on this changeset, and
  // per-file counts. Drives the approve gate (the FINALIZING approve refuses to
  // silently abandon the human's own proposal), the per-file "Looks right"
  // confirm, and the amber file-rail badges.
  const openSug = useMemo(() => summarizeOpenSuggestions(allComments), [allComments]);
  const openSugRef = useRef(openSug);
  openSugRef.current = openSug;

  // Cross-file threads: a comment carrying 2+ anchors binds locations across files.
  const crossFileComments = useMemo(
    () => allComments.filter((c) => Array.isArray(c.target.anchors) && c.target.anchors.length >= 2),
    [allComments],
  );

  // #186 — a changeset line comment anchors to a (side, line) pair, NOT a bare
  // line number: old-26 (a removed line) and new-26 (its replacement) are
  // DIFFERENT lines in the same file. Bucket by a side-qualified key so their
  // comments never merge. A legacy comment with no `side` reads as "new", so it
  // buckets exactly where it did before this change.
  const commentsByFileLine = useMemo(() => {
    const out: Record<string, Record<string, Comment[]>> = {};
    for (const c of allComments) {
      const t = c.target;
      if (!t.filePath || t.lineStart == null) continue;
      const side: "old" | "new" = t.side === "old" ? "old" : "new";
      const start = Math.max(0, Math.floor(Number(t.lineStart)));
      const end = t.lineEnd == null ? start : Math.max(start, Math.floor(Number(t.lineEnd)));
      const safeEnd = Math.min(end, start + 200);
      const byLine = (out[t.filePath] ??= {});
      for (let line = start; line <= safeEnd; line++) {
        (byLine[sideLineKey(side, line)] ??= []).push(c);
      }
    }
    return out;
  }, [allComments]);

  // Cross-file anchor chips keyed by path → (side, line). Cross-file anchors
  // carry no side, so they read as "new" — they never collide with an old-side
  // (removed-line) comment on the same number.
  const crossFileByFileLine = useMemo(() => {
    const out: Record<string, Record<string, Comment[]>> = {};
    for (const c of crossFileComments) {
      for (const a of c.target.anchors ?? []) {
        if (!a.filePath) continue;
        const line = Math.floor(Number(a.lineStart));
        if (!Number.isFinite(line)) continue;
        const byLine = (out[a.filePath] ??= {});
        (byLine[sideLineKey("new", line)] ??= []).push(c);
      }
    }
    return out;
  }, [crossFileComments]);

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

  // --- Derived dispositions + whole-changeset action -----------------------
  const dispositions = useMemo(
    () => files.map((f) => deriveChangesetDisposition(reviewState, f.path)),
    [files, reviewState],
  );
  const lookRightCount = dispositions.filter((d) => d === "reviewed").length;
  const flaggedFiles = files.filter((_, i) => dispositions[i] === "needs_changes");
  const flaggedCount = flaggedFiles.length;
  const pendingCount = dispositions.filter((d) => d === "pending").length;
  const allLookRight = files.length > 0 && flaggedCount === 0 && pendingCount === 0;
  const anyFlagged = flaggedCount > 0;
  /** The derived primary action: send-back (any flagged) > approve (all look
   *  right) > approve-all fast path (fresh / partial, nothing flagged). */
  const derived: "sendBack" | "approve" | "approveAll" = anyFlagged
    ? "sendBack"
    : allLookRight
      ? "approve"
      : "approveAll";

  // One open line-comment composer at a time, keyed by (path, line, side) — the
  // side is what lets a removed line (old-26) and its replacement (new-26) each
  // open their OWN composer instead of one stealing the other's row (#186).
  const [activeAnchor, setActiveAnchor] = useState<{ path: string; line: number; side: "old" | "new" } | null>(null);
  const [mode, setMode] = useState<LineMode>("comment");

  // Local needs-changes reason drafts (persisted to content.reviewReasons on blur
  // / on send-back). Seeded from persisted reasons when a file gets flagged.
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({});

  // Reject composer (whole-changeset — records the rejected APPROACH in the ledger).
  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [rejectConcept, setRejectConcept] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // H1 (#202) — the open-suggestion approve gates.
  //   approveConfirm       — the whole-changeset "N suggestions still open …
  //                          approve anyway?" inline confirm (lists the files).
  //   lookRightConfirmPath — the per-file "Looks right" confirm, scoped to that
  //                          file's open-suggestion count (one file at a time).
  const [approveConfirm, setApproveConfirm] = useState(false);
  const [lookRightConfirmPath, setLookRightConfirmPath] = useState<string | null>(null);

  const reasonBoxRef = useRef<HTMLTextAreaElement>(null);

  // --- Auto-advance to the next pending artifact after a terminal action ----
  const advanceToNextPending = useCallback(() => {
    const store = useArtifactStore.getState();
    const pending = computePending(store.artifacts).drafts.filter((a) => a.id !== artifact.id);
    const next = pending[0];
    if (next) store.selectArtifact(next.id);
  }, [artifact.id]);

  // --- The confirm-countdown that guards approve (never a silent commit) ----
  const runWhole = useCallback(
    async (
      status: "approved" | "revised" | "rejected",
      overrideFeedback?: string,
      opts?: { bypassSuggestionGate?: boolean },
    ) => {
      if (submitting) return;
      // H1 (#202) — the single choke point for EVERY approve path (button,
      // approve-all, the rising-edge countdown, the keyboard ⏎). With the
      // human's own suggestions still open, surface the confirm instead of
      // committing — never a silent abandon. "Approve anyway" passes the bypass.
      if (status === "approved" && !opts?.bypassSuggestionGate && openSugRef.current.total > 0) {
        setApproveConfirm(true);
        return;
      }
      setSubmitting(true);
      try {
        const trimmed = (overrideFeedback ?? feedback).trim();
        const concept = status === "rejected" ? rejectConcept.trim() || undefined : undefined;
        await updateArtifactStatus(artifact.id, status, trimmed || undefined, concept);
        setShowReject(false);
        setApproveConfirm(false);
        setFeedback("");
        setRejectConcept("");
        // After the verdict (and, for send-back, its feedback comment) posts,
        // move to the next thing waiting on the human.
        advanceToNextPending();
      } catch {
        /* store toasted + rolled back */
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, feedback, rejectConcept, updateArtifactStatus, artifact.id, advanceToNextPending],
  );

  const approveCountdown = useConfirmCountdown(() => { void runWhole("approved"); });
  const { countdown, countdownMax, armed, arm, cancel } = approveCountdown;

  // #175 — arm the confirm-countdown on the RISING edge into all-look-right
  // (the human just marked the last file). Mount-initialised so a reload of an
  // already-all-reviewed draft does NOT surprise-arm; a user Cancel latches
  // `held` so it can't immediately re-fire.
  const prevAllLookRightRef = useRef(allLookRight);
  useEffect(() => {
    const prev = prevAllLookRightRef.current;
    prevAllLookRightRef.current = allLookRight;
    if (!reviewActive) return;
    if (allLookRight && !prev && countdown === null && !approveCountdown.held) {
      // H1 (#202) — reaching all-look-right normally arms the approve countdown.
      // With a suggestion still open, surface the confirm instead so the human
      // can't sail past their own unresolved proposal on the auto-window.
      if (openSugRef.current.total > 0) setApproveConfirm(true);
      else arm(3);
    }
    // Leaving all-look-right (e.g. a file gets flagged) cancels a pending approve.
    if (!allLookRight && countdown !== null) cancel();
  }, [allLookRight, reviewActive, countdown, approveCountdown.held, arm, cancel]);

  // --- Disposition + action handlers ---------------------------------------
  // H1 (#202) — marking a file "Looks right" while a suggestion on THAT file is
  // still open is a mini-approval: the first press arms the per-file confirm,
  // the confirm (or a second press) marks it. Pure so the keyboard handler can
  // decide whether to advance BEFORE the async mark runs.
  const lookRightGated = useCallback(
    (path: string) => {
      const fo = openSugRef.current.byFile[path];
      return !!fo && fo.total > 0 && lookRightConfirmPath !== path;
    },
    [lookRightConfirmPath],
  );
  const markLookRight = useCallback(
    async (path: string, opts?: { bypassSuggestionGate?: boolean }) => {
      if (!opts?.bypassSuggestionGate && lookRightGated(path)) {
        setLookRightConfirmPath(path);
        return;
      }
      setLookRightConfirmPath(null);
      try { await setChangesetFileReview(artifact.id, path, "reviewed"); } catch { /* toasted */ }
    },
    [setChangesetFileReview, artifact.id, lookRightGated],
  );

  const markNeedsChanges = useCallback(
    async (path: string) => {
      setReasonDrafts((d) => (path in d ? d : { ...d, [path]: reviewReasons[path] ?? "" }));
      try { await setChangesetFileReview(artifact.id, path, "needs_changes", reviewReasons[path]); } catch { /* toasted */ }
      // Focus the reason box after it mounts.
      setTimeout(() => reasonBoxRef.current?.focus(), 0);
    },
    [setChangesetFileReview, artifact.id, reviewReasons],
  );

  const persistReason = useCallback(
    async (path: string) => {
      const draft = reasonDrafts[path];
      if (draft === undefined) return;
      try { await setChangesetFileReview(artifact.id, path, "needs_changes", draft); } catch { /* toasted */ }
    },
    [reasonDrafts, setChangesetFileReview, artifact.id],
  );

  const approveAll = useCallback(async () => {
    // Mark every not-yet-look-right file reviewed; the rising-edge effect then
    // arms the approve countdown (so it's still a visible, cancellable window).
    const toMark = files.filter((f) => deriveChangesetDisposition(reviewState, f.path) !== "reviewed");
    for (const f of toMark) {
      try { await setChangesetFileReview(artifact.id, f.path, "reviewed"); } catch { /* toasted */ }
    }
  }, [files, reviewState, setChangesetFileReview, artifact.id]);

  const sendBack = useCallback(async () => {
    const paths = flaggedFiles.map((f) => f.path);
    if (paths.length === 0) return;
    // Persist any un-blurred reason drafts, then compose the feedback from the
    // freshest reasons (local drafts win over persisted).
    const reasons: Record<string, string> = {};
    for (const p of paths) {
      const draft = reasonDrafts[p];
      const reason = (draft ?? reviewReasons[p] ?? "").trim();
      if (reason) reasons[p] = reason;
      if (draft !== undefined) {
        try { await setChangesetFileReview(artifact.id, p, "needs_changes", draft); } catch { /* toasted */ }
      }
    }
    const composed = composeSendBackFeedback(paths, reasons);
    await runWhole("revised", composed);
  }, [flaggedFiles, reasonDrafts, reviewReasons, setChangesetFileReview, artifact.id, runWhole]);

  const beginApprove = useCallback(() => {
    // H1 (#202) — the whole-changeset approve entry point (the ⏎ keymap and the
    // Approve-changeset button). Gate straight to the confirm when a suggestion
    // is open; otherwise arm the normal visible countdown.
    if (openSugRef.current.total > 0) { setApproveConfirm(true); return; }
    arm(3);
  }, [arm]);

  const fireDerivedAction = useCallback(() => {
    if (anyFlagged) { void sendBack(); return; }
    if (allLookRight) { beginApprove(); return; }
    void approveAll();
  }, [anyFlagged, allLookRight, sendBack, beginApprove, approveAll]);

  // --- Keyboard: routed through the ONE central keymap, scoped to focus -----
  // A ref-held handler keeps every closure fresh without re-subscribing per
  // keystroke; the listener re-binds only when focus/interactivity changes.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    // While ANY overlay is open (command palette, settings — INCLUDING this
    // PR's own `?` cheat-sheet, a focus-trapped dialog with no input), the
    // changeset behind it must not act on keystrokes: mirror App.tsx's
    // overlayOpenRef suppression (App.tsx:245). Return WITHOUT stopPropagation so
    // Esc / `?` / n / q still reach the global handler and can close the overlay.
    if (useOverlayStore.getState().count > 0) return;
    // Never steal keys while the human is typing (reason box, composer, reject).
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable === true) return;
    const intent = resolveChangesetKey(e);
    if (!intent) return;
    // Handle it here AND stop the global App handler (a/r/j/k) from also firing.
    e.preventDefault();
    e.stopPropagation();
    const goto = (i: number) => {
      const next = Math.max(0, Math.min(i, files.length - 1));
      setActiveIdx(next);
      setActiveAnchor(null);
      if (reviewAll) {
        setTimeout(() => document.querySelector(`[data-changeset-file="${next}"]`)?.scrollIntoView?.({ block: "start", behavior: "smooth" }), 0);
      }
    };
    const act: Record<ChangesetIntent, () => void> = {
      lookRight: () => {
        const f = files[clampedIdx];
        if (!f) return;
        // H1 (#202) — when the per-file confirm arms, stay on the file so the
        // human sees (and can confirm) it; only advance on an actual mark.
        const gated = lookRightGated(f.path);
        void markLookRight(f.path);
        if (!gated) goto(clampedIdx + 1);
      },
      needsChanges: () => {
        const f = files[clampedIdx];
        if (f) void markNeedsChanges(f.path);
      },
      nextFile: () => goto(clampedIdx + 1),
      prevFile: () => goto(clampedIdx - 1),
      fireDerivedAction: () => fireDerivedAction(),
      approveAll: () => { void approveAll(); },
    };
    act[intent]();
  };
  useEffect(() => {
    // Review keys (a/r/j/k/⏎) belong to the OPEN review only — never bound on a
    // closed changeset in the late follow-up lane.
    if (!isFocused || !reviewActive) return;
    const listener = (e: KeyboardEvent) => keyHandlerRef.current(e);
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [isFocused, reviewActive]);

  // ------------------------------------------------------------------------
  const renderFileDiff = (file: ChangesetFile) => {
    const byLine = commentsByFileLine[file.path] ?? {};
    const xByLine = crossFileByFileLine[file.path] ?? {};
    return (
      <div className="font-mono text-[13px] leading-[20px] bg-surface-primary">
        {file.hunks.length === 0 && (
          <div className="px-3 py-2 text-2xs text-text-muted italic">No diff hunks for this file.</div>
        )}
        {file.hunks.map((hunk, hi) => {
          // P2 fix 1 (round-11 MED) — the HUNK grain, finally reachable. The
          // guidance has promised "scope to exactly that hunk … not a whole-file
          // tour" since O2, but every live call site emitted {kind:"file"} — the
          // hunk branch had zero production callers. The hunk header is the one
          // place a reader is already looking at a single hunk, so the affordance
          // lives there, carrying the hunk's REAL line range (derived from its
          // line numbers; withheld when the agent supplied none).
          const range = hunkLineRange(hunk);
          const hunkHeaderBar = (hunk.header || range) && (
            <div className="flex items-start gap-2 font-mono text-2xs text-accent-cyan bg-surface-code px-3 py-1 border-y border-border-subtle">
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{hunk.header}</span>
              {range && (
                <WalkMeThroughButton
                  compact
                  target={{
                    kind: "hunk",
                    filePath: file.path,
                    artifactId: artifact.id,
                    // P2 review F1 — a DELETED file's path is gone from the
                    // working tree entirely; the ask has to say so.
                    ...(file.changeType === "deleted" ? { fileRemoved: true } : {}),
                    ...range,
                  }}
                  className="-my-0.5"
                />
              )}
            </div>
          );
          return (
          <div key={hi}>
            {hunkHeaderBar}
            {hunk.lines.map((line, li) => {
              const newLine = line.newLine ?? null;
              const oldLine = line.oldLine ?? null;
              // #186 — a line's comment anchor is its NEW-side number (add / ctx),
              // or — when there is no new-side line (a `del`) — its OLD-side
              // number, tagged side:"old". This makes removed lines (and a fully
              // deleted file, which is ALL del lines) commentable, and keeps
              // add/ctx lines byte-identical to the pre-#186 new-side behavior.
              const anchorSide: "old" | "new" = newLine == null ? "old" : "new";
              const anchorLine = newLine == null ? oldLine : newLine;
              // #187 — gutters/composers/threads follow commentsUnlocked (draft OR
              // approved), NOT reviewActive: late follow-up commenting on a closed
              // changeset stays live while its review affordances are gone.
              const commentable = commentsUnlocked && anchorLine != null;
              const lineComments = anchorLine != null ? byLine[sideLineKey(anchorSide, anchorLine)] ?? [] : [];
              // Cross-file chips are new-side only, so an old-side lookup is
              // always empty — a removed line never shows a stray cross-file chip.
              const xfileChips = anchorLine != null ? xByLine[sideLineKey(anchorSide, anchorLine)] ?? [] : [];
              const isActive =
                commentable &&
                activeAnchor?.path === file.path &&
                activeAnchor.line === anchorLine &&
                activeAnchor.side === anchorSide;
              const anchorKey =
                anchorLine != null ? `line:${file.path}:${anchorSide === "old" ? "old:" : ""}${anchorLine}` : undefined;
              return (
                <div key={`${hi}-${li}`} data-comment-anchor={anchorKey}>
                  <div className={`flex group ${line.kind === "del" ? "bg-accent-red-dim/30" : line.kind === "add" ? "bg-accent-green-dim/30" : ""}`}>
                    {commentable ? (
                      <LineGutter
                        lineNum={anchorLine!}
                        commentCount={lineComments.length}
                        active={!!isActive}
                        activeMode={mode}
                        onOpen={(m) => { setActiveAnchor({ path: file.path, line: anchorLine!, side: anchorSide }); setMode(m); }}
                        onClose={() => setActiveAnchor(null)}
                        className="w-10 shrink-0 pr-0.5"
                      />
                    ) : (
                      <span className="w-10 shrink-0" />
                    )}
                    <span className="w-8 shrink-0 text-right pr-1 py-0.5 text-2xs text-text-muted select-none">{line.oldLine ?? ""}</span>
                    <span className="w-8 shrink-0 text-right pr-2 py-0.5 text-2xs text-text-muted select-none border-r border-border-subtle">{line.newLine ?? ""}</span>
                    <span className={`w-5 shrink-0 text-center py-0.5 select-none font-bold ${line.kind === "del" ? "text-accent-red" : line.kind === "add" ? "text-accent-green" : "text-text-muted"}`}>
                      {line.kind === "del" ? "−" : line.kind === "add" ? "+" : " "}
                    </span>
                    <span className={`px-2 py-0.5 whitespace-pre-wrap break-words flex-1 min-w-0 ${line.kind === "ctx" ? "text-text-secondary" : "text-text-primary"}`}>
                      {line.content || " "}
                    </span>
                    {xfileChips.length > 0 && (
                      <span className="shrink-0 self-center mr-2 inline-flex items-center gap-1 text-2xs font-bold text-accent-blue bg-accent-blue-dim rounded px-1.5 py-0.5 font-mono" title="Part of a cross-file comment thread">
                        ↔ cross-file
                      </span>
                    )}
                  </div>
                  {commentable && lineComments.length > 0 && (
                    <SuggestionLineFeedback
                      lineComments={lineComments}
                      lineNum={anchorLine!}
                      side={anchorSide}
                      artifactId={artifact.id}
                      filePath={file.path}
                      hideChips={!!isActive}
                      onOpenLine={() => { setActiveAnchor({ path: file.path, line: anchorLine!, side: anchorSide }); setMode("comment"); }}
                    />
                  )}
                  {isActive && (
                    <LineComposer
                      lineNum={anchorLine!}
                      artifactId={artifact.id}
                      filePath={file.path}
                      // A removed line has no new-side text to Suggest against — pass
                      // it only for new-side lines so Suggest stays available there.
                      lineText={anchorSide === "new" ? line.content : undefined}
                      side={anchorSide}
                      // #187 — in the late lane: withhold Suggest (a review action)
                      // and surface the follow-up honesty marker.
                      allowSuggest={reviewActive}
                      followUpLane={followUpLane}
                      mode={mode}
                      setMode={setMode}
                      existingComments={lineComments}
                      onClose={() => setActiveAnchor(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
          );
        })}
      </div>
    );
  };

  /** The two per-file disposition buttons + the inline needs-changes reason box. */
  const renderDispositionControls = (file: ChangesetFile) => {
    if (!reviewActive) return null;
    const disp = deriveChangesetDisposition(reviewState, file.path);
    return (
      <div className="ml-auto flex items-center gap-1.5" data-testid="disposition-controls">
        <button
          type="button"
          onClick={() => markLookRight(file.path)}
          aria-pressed={disp === "reviewed"}
          data-testid="looks-right"
          className={`px-2 py-1 text-2xs font-semibold rounded border transition-colors inline-flex items-center gap-1 ${
            disp === "reviewed"
              ? "text-accent-green border-accent-green bg-accent-green-dim"
              : "text-text-secondary border-border-default hover:bg-surface-hover"
          }`}
          title="This file looks right"
        >
          ✓ Looks right
        </button>
        <button
          type="button"
          onClick={() => markNeedsChanges(file.path)}
          aria-pressed={disp === "needs_changes"}
          data-testid="needs-changes"
          className={`px-2 py-1 text-2xs font-semibold rounded border transition-colors inline-flex items-center gap-1 ${
            disp === "needs_changes"
              ? "text-accent-amber border-accent-amber bg-accent-amber-dim"
              : "text-text-secondary border-border-default hover:bg-surface-hover"
          }`}
          title="Flag this file for changes (captures a reason)"
        >
          ↻ Needs changes
        </button>
      </div>
    );
  };

  const renderNeedsBox = (file: ChangesetFile, focusable: boolean) => {
    if (!reviewActive || deriveChangesetDisposition(reviewState, file.path) !== "needs_changes") return null;
    return (
      <div
        className="m-3 border border-accent-amber border-l-[3px] rounded-r-lg bg-surface-secondary overflow-hidden"
        data-testid="needs-box"
      >
        <div className="flex items-center gap-2 px-3 py-2 text-2xs font-semibold text-accent-amber">
          ↻ Tell the agent what to change in <span className="font-mono text-text-secondary font-medium">{file.path}</span>
        </div>
        <div className="px-3 pb-2.5">
          <textarea
            ref={focusable ? reasonBoxRef : undefined}
            rows={2}
            value={reasonDrafts[file.path] ?? reviewReasons[file.path] ?? ""}
            onChange={(e) => setReasonDrafts((d) => ({ ...d, [file.path]: e.target.value }))}
            onBlur={() => persistReason(file.path)}
            aria-label={`Reason this file needs changes: ${file.path}`}
            placeholder="e.g. keep the TTL bump on the login path — the OAuth callback never goes through this middleware"
            className="w-full px-2 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-amber resize-none"
          />
        </div>
      </div>
    );
  };

  /** H1 (#202) — the per-file "Looks right" confirm, scoped to THAT file's open
   *  suggestions. Naming the open states so marking it settled is a considered
   *  call, not an accident. "Looks right anyway" bypasses the gate. */
  const renderLookRightConfirm = (file: ChangesetFile) => {
    if (!reviewActive || lookRightConfirmPath !== file.path) return null;
    const fo = openSug.byFile[file.path];
    if (!fo || fo.total === 0) return null;
    return (
      <div
        className="m-3 border border-accent-amber border-l-[3px] rounded-r-lg bg-accent-amber-dim/15 overflow-hidden"
        data-testid="looks-right-confirm"
      >
        <div className="px-3 py-2 text-2xs text-text-secondary">
          <span className="text-accent-amber font-semibold">
            ⚠ {fo.total} of your suggestions {fo.total === 1 ? "is" : "are"} still open ({describeOpenStates(fo)})
          </span>{" "}
          on <span className="font-mono text-text-secondary">{file.path}</span> — mark it look-right anyway?
        </div>
        <div className="flex items-center gap-2 px-3 pb-2.5">
          <button
            type="button"
            onClick={() => void markLookRight(file.path, { bypassSuggestionGate: true })}
            data-testid="looks-right-anyway"
            className="px-2.5 py-1 text-2xs font-semibold text-text-inverse bg-accent-amber rounded hover:bg-accent-amber/85 transition-colors"
            title="Mark this file look-right even though your suggestion is still open"
          >
            ✓ Looks right anyway
          </button>
          <button
            type="button"
            onClick={() => setLookRightConfirmPath(null)}
            className="text-2xs text-text-muted hover:text-text-secondary"
          >
            Keep reviewing
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3" data-changeset-focused={isFocused ? "true" : undefined}>
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
              <span key={r} className="inline-flex items-center gap-1 text-2xs font-bold tracking-wide uppercase text-accent-amber bg-accent-amber-dim rounded px-1.5 py-0.5">
                ⚠ {r}
              </span>
            ))}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          {/* Review-all toggle */}
          <span className="inline-flex border border-border-default rounded overflow-hidden" role="group" aria-label="Review mode">
            <button
              type="button"
              onClick={() => setReviewAll(false)}
              aria-pressed={!reviewAll}
              className={`text-2xs font-semibold px-2.5 py-1 ${!reviewAll ? "bg-surface-active text-accent-blue" : "bg-surface-elevated text-text-muted hover:bg-surface-hover"}`}
            >
              File-by-file
            </button>
            <button
              type="button"
              onClick={() => setReviewAll(true)}
              aria-pressed={reviewAll}
              className={`text-2xs font-semibold px-2.5 py-1 ${reviewAll ? "bg-surface-active text-accent-blue" : "bg-surface-elevated text-text-muted hover:bg-surface-hover"}`}
            >
              Review all ↧
            </button>
          </span>
          <span className="text-2xs text-text-muted" style={{ fontVariantNumeric: "tabular-nums" }} data-testid="disposition-summary">
            <b className="text-accent-green">{lookRightCount} look right</b>
            {flaggedCount > 0 && <> · <b className="text-accent-amber">{flaggedCount} needs {flaggedCount === 1 ? "change" : "changes"}</b></>}
            {" · "}{files.length} files
          </span>
        </span>
      </div>

      {reviewAll ? (
        /* --- Review-all: every file's diff stacked in one scroll ------------ */
        <div className="space-y-3">
          {files.map((f, i) => (
            <div key={`${f.path}-${i}`} data-changeset-file={i} className="border border-border-subtle rounded overflow-hidden bg-surface-primary">
              {/* P2 (round-11 UX) — the file-path row does NOT wrap at review
                  widths: the DIRECTORY truncates (the basename always survives —
                  review F3) so the actions stay on ONE 41px line instead of
                  pushing the header to a second row on a deep path. Below
                  1100px — where the row genuinely cannot hold path + stats +
                  three actions — it wraps again rather than overlapping. */}
              <div className="flex flex-wrap min-[1100px]:flex-nowrap items-center gap-2 px-3 py-2 border-b border-border-subtle font-mono text-xs bg-surface-primary">
                <span className={`font-bold text-2xs shrink-0 ${changeMark[f.changeType].cls}`}>{changeMark[f.changeType].letter}</span>
                <FilePathLabel path={f.path} />
                <OpenInEditorLink filePath={f.path} line={1} />
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  <WalkMeThroughButton target={{ kind: "file", filePath: f.path, artifactId: artifact.id }} />
                  {renderDispositionControls(f)}
                </span>
              </div>
              {renderNeedsBox(f, false)}
              {renderLookRightConfirm(f)}
              {renderFileDiff(f)}
            </div>
          ))}
        </div>
      ) : (
        /* --- File-by-file: rail + single diff pane ------------------------- */
        <div className="grid grid-cols-1 min-[820px]:grid-cols-[240px_1fr] gap-3">
          {/* File rail */}
          <div className="border border-border-subtle rounded bg-surface-secondary py-2 self-start">
            <div className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-text-muted">Changed files</div>
            <ul>
              {files.map((f, i) => {
                const mark = changeMark[f.changeType];
                const s = fileStats(f);
                const disp: ChangesetDisposition = dispositions[i] ?? "pending";
                const openComments = commentCountByFile[f.path] ?? 0;
                // M1 (#202) — an open (pending/countered) suggestion on this file
                // is a live negotiation, not an old comment: give it a DISTINCT
                // amber badge so it can't hide behind an undifferentiated count.
                const fileOpenSug = openSug.byFile[f.path];
                const isActive = i === clampedIdx;
                return (
                  <li key={`${f.path}-${i}`}>
                    <button
                      type="button"
                      onClick={() => { setActiveIdx(i); setActiveAnchor(null); }}
                      aria-current={isActive ? "true" : undefined}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 font-mono text-[11.5px] border-l-2 text-left ${
                        isActive ? "bg-surface-active border-accent-blue text-text-primary" : "border-transparent text-text-secondary hover:bg-surface-hover"
                      }`}
                      title={`${mark.label} ${f.path}`}
                    >
                      <span className={`w-3 text-center font-bold text-2xs shrink-0 ${mark.cls}`} aria-label={mark.label}>{mark.letter}</span>
                      <span className="flex-1 min-w-0 truncate">{f.path}</span>
                      <StatBar additions={s.additions} deletions={s.deletions} />
                      {fileOpenSug && fileOpenSug.total > 0 && (
                        <span
                          data-testid="open-suggestion-badge"
                          className="shrink-0 text-2xs text-accent-amber bg-accent-amber-dim font-sans font-bold rounded-full px-1.5 py-0.5"
                          title={`${fileOpenSug.total} open suggestion${fileOpenSug.total === 1 ? "" : "s"} (${describeOpenStates(fileOpenSug)})`}
                        >
                          !{fileOpenSug.total}
                        </span>
                      )}
                      {disp === "pending" && openComments > 0 ? (
                        <span className="shrink-0 text-2xs text-accent-blue font-sans font-bold" title={`${openComments} comment${openComments === 1 ? "" : "s"}`}>●{openComments}</span>
                      ) : (
                        <DispChip disposition={disp} />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Cross-file comment cards */}
            {crossFileComments.map((c) => (
              <div key={c.id} className="mx-2 mt-2.5 p-2 bg-accent-blue-dim border border-border-focus rounded text-2xs text-text-secondary leading-snug">
                <div className="text-2xs font-bold tracking-wide text-accent-blue mb-0.5">CROSS-FILE COMMENT</div>
                <div>{c.content}</div>
                <div className="font-mono text-[10.5px] text-text-primary mt-1">
                  {(c.target.anchors ?? []).map((a, i) => (
                    <span key={`${a.filePath}-${a.lineStart}`}>{i > 0 ? " ↔ " : ""}{a.filePath}:{a.lineStart}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Diff pane for the active file */}
          <div className="min-w-0 border border-border-subtle rounded overflow-hidden bg-surface-primary" data-changeset-file={clampedIdx}>
            {activeFile ? (
              <>
                {/* P2 (round-11 UX) — see the review-all header above: one line
                    at review widths (directory truncates, basename survives),
                    wrapping only below 1100px. */}
                <div className="flex flex-wrap min-[1100px]:flex-nowrap items-center gap-2 px-3 py-2 border-b border-border-subtle font-mono text-xs bg-surface-primary">
                  <span className={`font-bold text-2xs shrink-0 ${changeMark[activeFile.changeType].cls}`}>{changeMark[activeFile.changeType].letter}</span>
                  <FilePathLabel path={activeFile.path} />
                  <OpenInEditorLink filePath={activeFile.path} line={1} />
                  <span className="ml-auto flex items-center gap-2 shrink-0">
                    {(() => {
                      const s = fileStats(activeFile);
                      return (
                        <span className="text-2xs text-text-muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                          <span className="text-accent-green">+{s.additions}</span>{" "}
                          <span className="text-accent-red">−{s.deletions}</span>
                        </span>
                      );
                    })()}
                    <WalkMeThroughButton target={{ kind: "file", filePath: activeFile.path, artifactId: artifact.id }} />
                    {renderDispositionControls(activeFile)}
                  </span>
                </div>
                {/* Keyboard hint strip */}
                {reviewActive && (
                  <div className="flex items-center gap-x-4 gap-y-1 flex-wrap px-3 py-1.5 bg-surface-code border-b border-border-subtle text-[10.5px] text-text-muted">
                    <span><b className="text-text-secondary">a</b> looks right → next</span>
                    <span><b className="text-text-secondary">r</b> needs changes</span>
                    <span><b className="text-text-secondary">j</b>/<b className="text-text-secondary">k</b> next/prev file</span>
                    <span><b className="text-text-secondary">⏎</b> {derived === "sendBack" ? "send back" : "approve"}</span>
                    <span className="ml-auto">press <b className="text-text-secondary">?</b> for all shortcuts</span>
                  </div>
                )}
                {renderNeedsBox(activeFile, true)}
                {renderLookRightConfirm(activeFile)}
                {renderFileDiff(activeFile)}
              </>
            ) : (
              <div className="px-3 py-4 text-xs text-text-muted">This changeset has no files.</div>
            )}
          </div>
        </div>
      )}

      {/* Whole-changeset action bar (draft + non-replay only) — DERIVED action.
          Stays gated on reviewActive: the late follow-up lane shows NO review
          actions (no Approve/Send-back/Reject, no countdown). */}
      {reviewActive && (
        <div className="space-y-2 pt-2 border-t border-border-default">
          {/* H1/M1 (#202) — the open-suggestion approve gate. Names the count +
              states AND lists the files carrying them, so file-by-file mode
              can't hide an unresolved negotiation. "Approve anyway" is the
              human's explicit call (bypasses the gate). */}
          {approveConfirm && openSug.total > 0 && (
            <div
              data-testid="approve-open-suggestions-confirm"
              className="space-y-1.5 p-2.5 rounded border border-accent-amber/40 bg-accent-amber-dim/15"
            >
              <div className="text-2xs text-text-secondary">
                <span className="text-accent-amber font-semibold">⚠ {openSuggestionsConfirmLabel(openSug)}</span>{" "}
                on <span className="font-mono text-text-secondary" data-testid="approve-confirm-files">{openSug.files.join(", ")}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void runWhole("approved", undefined, { bypassSuggestionGate: true })}
                  disabled={submitting}
                  data-testid="approve-anyway"
                  className="px-2.5 py-1 text-2xs font-semibold text-text-inverse bg-accent-amber rounded hover:bg-accent-amber/85 disabled:opacity-50 transition-colors"
                  title="Approve the changeset even though your suggestions are still open"
                >
                  Approve anyway
                </button>
                <button
                  type="button"
                  onClick={() => setApproveConfirm(false)}
                  disabled={submitting}
                  className="text-2xs text-text-muted hover:text-text-secondary"
                >
                  Keep reviewing
                </button>
              </div>
            </div>
          )}

          {/* Confirm-countdown (armed when all files look right) */}
          {armed && countdown !== null && countdown > 0 && (
            <div className="space-y-1.5" data-testid="approve-countdown">
              <div className="flex items-center justify-between">
                <span className="text-2xs text-accent-green">Approving in {countdown}… · press to comment · Esc to hold</span>
                <button onClick={cancel} className="text-2xs text-text-muted hover:text-text-secondary" data-testid="hold-approve">
                  Hold
                </button>
              </div>
              <div className="h-0.5 bg-surface-elevated rounded-full overflow-hidden">
                <div className="h-full bg-accent-green transition-all duration-1000 ease-linear" style={{ width: `${(countdown / countdownMax) * 100}%` }} />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xs text-text-secondary mr-auto max-w-[52ch]" data-testid="action-status">
              {anyFlagged ? (
                <>
                  <b className="text-accent-green">{lookRightCount} look right</b>, <b className="text-accent-amber">{flaggedCount} needs {flaggedCount === 1 ? "change" : "changes"}</b> — the flagged {flaggedCount === 1 ? "file goes" : "files go"} back for revision, the rest are accepted.
                </>
              ) : allLookRight ? (
                <><b className="text-accent-green">All {files.length} files look right.</b> Approving with a short window to add a comment.</>
              ) : (
                <>Skim file-by-file, or trust it at a glance with <b className="text-text-primary">Approve all</b>.</>
              )}
            </span>

            <button
              type="button"
              onClick={() => { setShowReject((v) => !v); setRejectConcept((artifact.content as { concept?: { name?: string } } | null)?.concept?.name ?? ""); }}
              disabled={submitting}
              className="px-2.5 py-1 text-2xs font-semibold text-accent-red rounded border border-accent-red/30 hover:bg-accent-red-dim disabled:opacity-50 transition-colors"
              data-testid="reject-approach"
              title="Reject this approach — you don't want any version of this changeset. Remembered across sessions."
            >
              ✕ Reject
            </button>

            {derived === "sendBack" ? (
              <button
                type="button"
                onClick={() => void sendBack()}
                disabled={submitting}
                className="px-3 py-1.5 text-xs font-semibold text-text-inverse bg-accent-amber rounded hover:bg-accent-amber/85 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                data-testid="send-back"
                title={`Send back ${flaggedCount} flagged ${flaggedCount === 1 ? "file" : "files"} for revision`}
              >
                ↻ Send back {flaggedCount} {flaggedCount === 1 ? "file" : "files"}
              </button>
            ) : derived === "approve" ? (
              <button
                type="button"
                onClick={() => (armed ? cancel() : beginApprove())}
                disabled={submitting}
                className="px-3 py-1.5 text-xs font-semibold text-text-inverse bg-accent-green rounded hover:bg-accent-green/85 disabled:opacity-50 transition-colors"
                data-testid="approve-changeset"
                title="Approve the whole changeset"
              >
                ✓ Approve changeset
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void approveAll()}
                disabled={submitting}
                className="px-3 py-1.5 text-xs font-semibold text-text-inverse bg-accent-green rounded hover:bg-accent-green/85 disabled:opacity-50 transition-colors"
                data-testid="approve-all"
                title={`Mark all ${files.length} files look-right and approve`}
              >
                ✓ Approve all {files.length} files
              </button>
            )}
          </div>

          {showReject && (
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
                  onClick={() => void runWhole("rejected")}
                  disabled={submitting || !feedback.trim()}
                  className="px-2.5 py-1 text-2xs font-medium text-white bg-accent-red rounded hover:bg-accent-red/80 disabled:opacity-50 transition-colors"
                  title="Reject and remember this approach across every project"
                >
                  Reject &amp; remember
                </button>
                <button type="button" onClick={() => setShowReject(false)} className="text-2xs text-text-muted hover:text-text-secondary">
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
