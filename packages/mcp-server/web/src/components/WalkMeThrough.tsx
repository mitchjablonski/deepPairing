import { useEffect, useRef, useState } from "react";
import type { ChangesetHunk, RequestScope } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { useReplayStore } from "../stores/replay";
import { useToastStore } from "../stores/toast";
import { noAgentLive } from "../lib/liveness";
import { CompassIcon } from "./icons/ArtifactIcons";

/**
 * O2 (#230) — the "Walk me through this" affordance. The round-10 review found
 * the explainer BUILT-NOT-DELIVERED: pull-only via prose, ZERO organic
 * invocations, because nothing is a CTA for the INITIAL invocation. This is that
 * CTA — a one-click, in-front-of-you-mid-review button that emits a SCOPED
 * "explain" REQUEST on the EXISTING request pipe (G1's composer → /api/requests →
 * the check_feedback request lane → linkServedRequest). It is a NEW ENTRY POINT
 * to that pipe, not new plumbing: an "explain"-intent request is exactly what
 * present_explainer serves, and the served-linkage flips the composer pip when
 * the agent responds with a present_explainer carrying servedRequestId.
 *
 * P2 (round-11) — the TRUTH-UP. Round 11 found O2 shipped the shape, not the
 * substance, on three counts, all fixed here:
 *   1. the {kind:"hunk"} grain had ZERO call sites (guidance promised hunk
 *      scope, the UI only ever emitted whole-file) → the button now takes a
 *      TARGET and the changeset renders one per hunk as well as per file;
 *   2. the needs-your-eyes entry point passed a BOOLEAN `hasArtifactRef`, so
 *      the text said "the linked artifact" while the ref itself never travelled
 *      → the ref now rides both the prose and the scope data;
 *   3. scope was PROSE only — indistinguishable from a hand-typed composer
 *      request → every click now also sends `source` + `scope` as structured
 *      data (shared RequestScope), so copy drift can't silently degrade the ask
 *      and the agent can auto-link relatedArtifactIds.
 * The human-readable text stays the PRIMARY instruction; the data is additive.
 *
 * Quiet by design (a muted text link, never competing with the review actions),
 * keyboard-accessible (a plain <button>), themed via semantic tokens.
 */

/** What a click is scoped to. One target type per grain — the button derives the
 *  text, the structured scope, the label and the accessible name from it, so no
 *  call site can pair a "this hunk" label with a whole-file ask. */
/** A hunk's line envelope, WITH the side its numbers belong to (P2 review F1/F2). */
export type HunkRange = {
  lineStart: number;
  lineEnd: number;
  /** "new" = post-change (what the working tree holds); "old" = PRE-change. */
  side: "new" | "old";
  /** A mixed hunk's removed lines (pre-change numbers) — outside the new range. */
  oldStart?: number;
  oldEnd?: number;
  removedLineCount?: number;
};

export type WalkTarget =
  | { kind: "file"; filePath: string; artifactId?: string }
  | ({
      kind: "hunk";
      filePath: string;
      artifactId?: string;
      /** The file is DELETED in this changeset — the path is gone from the tree. */
      fileRemoved?: boolean;
    } & HunkRange)
  | {
      kind: "needs-eyes";
      what: string;
      why?: string;
      /** The artifact this flagged item points at (debrief needs-your-eyes `artifactRef`). */
      artifactRef?: string;
      /** The debrief itself — where the item was flagged. */
      artifactId?: string;
      /** Within-artifact anchor, e.g. "debrief:needs-your-eyes:2". */
      itemRef?: string;
    };

/** Build the scoped instruction a click emits. Exported + pure so it can be
 *  unit-tested and so the changeset/debrief entry points can't drift on how they
 *  phrase the ask. The text is a clear instruction the agent acts on with a
 *  present_explainer scoped to the given target. */
export function buildWalkMeThroughRequest(target: WalkTarget): string {
  if (target.kind === "file") {
    // P2 review (judgment call) — this button lives in a CHANGESET file header,
    // so "how <path> works … how the pieces fit together" licensed a tour of a
    // 2000-line file of which six lines changed: the round-10 whole-file-tour
    // failure, re-entered through the file door. The ask is now THIS FILE'S
    // CHANGES (the scope stays the file — the surrounding code is context, not
    // the subject).
    return (
      `Walk me through the changes to ${target.filePath} in this changeset — respond with a present_explainer ` +
      `scoped to this file's changes: what they do, how they fit with the rest of the file, and anything I should ` +
      `watch for. Explain the CHANGES; read the rest of the file only as much as you need to explain them.`
    );
  }
  if (target.kind === "hunk") {
    const removed = target.removedLineCount ?? 0;
    // P2 review F1 — a PURE-DELETION hunk carries PRE-change numbers. Handing
    // the agent "lines 8–9" of a path it can open post-change is how it reads
    // unrelated code and confidently explains the wrong thing.
    if (target.side === "old") {
      const what = target.fileRemoved
        ? `${target.filePath}, which this changeset DELETES`
        : `${target.filePath}`;
      return (
        `Walk me through the ${removed > 0 ? `${removed} line${removed === 1 ? "" : "s"} removed` : "removal"} from ${what} ` +
        `— PRE-change lines ${target.lineStart}–${target.lineEnd}. Those lines NO LONGER EXIST in the working tree` +
        `${target.fileRemoved ? " (nor does the file)" : ""}, so read them from the changeset diff, not from disk. ` +
        `Respond with a present_explainer scoped to this hunk: what was removed and why it mattered. ` +
        `Scope to exactly this hunk, not a whole-file tour.`
      );
    }
    // P2 review F2 — the removed lines of a mixed hunk are outside the range.
    const oldEnd = target.oldEnd ?? target.oldStart;
    const oldRange =
      target.oldStart != null && oldEnd !== target.oldStart
        ? `PRE-change lines ${target.oldStart}–${oldEnd}`
        : `PRE-change line ${target.oldStart}`;
    const removedClause =
      target.oldStart != null
        ? ` This hunk also removes ${removed > 0 ? `${removed} line${removed === 1 ? "" : "s"}` : "lines"} ` +
          `(${oldRange}) that are gone from the working tree — read those from the diff and cover them too.`
        : "";
    return (
      `Walk me through the change to ${target.filePath} at lines ${target.lineStart}–${target.lineEnd} ` +
      `(post-change line numbers) — respond with a present_explainer scoped to this hunk: what it does and why.` +
      `${removedClause} Scope to exactly this hunk, not a whole-file tour.`
    );
  }
  // P2 fix 2 — the ref TRAVELS: name the artifact id in the text (and in the
  // scope data below), instead of the old boolean that only said one exists.
  // P2 review F6 — when the item points at another artifact, name BOTH: the
  // target it scopes to AND the debrief the item was flagged in (which is what
  // `itemRef` anchors into — an anchor whose artifact the ask never named).
  const flaggedIn = target.artifactId ? ` (flagged for me in debrief ${target.artifactId})` : "";
  const scopeTarget = target.artifactRef ? `the linked artifact ${target.artifactRef}${flaggedIn}` : "this";
  const whyClause = target.why ? ` (${target.why})` : "";
  return (
    `Walk me through "${target.what}"${whyClause} — respond with a present_explainer scoped to ${scopeTarget}: ` +
    `help me understand what to look at and why it matters.`
  );
}

/** The same target rendered as STRUCTURED scope (P2 fix 3). Every field is
 *  optional in the shared schema, and this returns only what the target knows —
 *  so the agent gets machine-usable scope without the UI inventing anything. */
export function buildWalkMeThroughScope(target: WalkTarget): RequestScope {
  if (target.kind === "file") {
    return { filePath: target.filePath, ...(target.artifactId ? { artifactId: target.artifactId } : {}) };
  }
  if (target.kind === "hunk") {
    return {
      filePath: target.filePath,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd,
      // P2 review F1/F2 — the side is ALWAYS explicit for a hunk, and a mixed
      // hunk's removals ride along; a bare range would be read as post-change.
      side: target.side,
      ...(target.oldStart != null ? { oldStart: target.oldStart } : {}),
      ...(target.oldEnd != null ? { oldEnd: target.oldEnd } : {}),
      ...(target.removedLineCount != null ? { removedLineCount: target.removedLineCount } : {}),
      ...(target.fileRemoved ? { fileRemoved: true } : {}),
      ...(target.artifactId ? { artifactId: target.artifactId } : {}),
    };
  }
  // The item POINTS AT artifactRef; that is what the explainer scopes to. P2
  // review F6 — the debrief it was flagged IN rides as `sourceArtifactId`, so
  // `itemRef` no longer anchors into an artifact the scope never names.
  const artifactId = target.artifactRef ?? target.artifactId;
  const sourceArtifactId = target.artifactRef && target.artifactId ? target.artifactId : undefined;
  return {
    ...(artifactId ? { artifactId } : {}),
    ...(sourceArtifactId ? { sourceArtifactId } : {}),
    ...(target.itemRef ? { itemRef: target.itemRef } : {}),
  };
}

/** P2 fix 4 (UX MED) — an HONEST label, per grain. "Walk me through this" left
 *  the SCOPE ambiguous (hunk? file? the whole changeset?); the label now names
 *  exactly what the click will explain. */
export function walkMeThroughLabel(target: WalkTarget): string {
  // P2 review (judgment call) — "Explain this file" invited (and the prose
  // licensed) a whole-file tour from a CHANGESET header. The label names what
  // is actually being asked about: this file's changes.
  if (target.kind === "file") return "Explain this file's changes";
  if (target.kind === "hunk") return "Explain this hunk";
  return "Explain this";
}

/** The accessible name — the surrounding context, spelled out for screen readers. */
export function walkMeThroughAria(target: WalkTarget): string {
  if (target.kind === "file") return `the changes to ${target.filePath} in this changeset`;
  if (target.kind === "hunk") {
    const sideWord = target.side === "old" ? "pre-change lines" : "lines";
    return `the change to ${target.filePath} at ${sideWord} ${target.lineStart} to ${target.lineEnd}`;
  }
  return target.what || "this flagged item";
}

/**
 * P2 fix 1 — derive a hunk's real line range from its lines. The changeset
 * schema stores hunks as `{header, lines}` with per-line old/new numbers and no
 * explicit range, so the range is the min/max of the numbers actually shown:
 * new-side when the hunk has any new-side line (the numbers the reader sees for
 * added/context lines), old-side for a pure-deletion hunk. Returns null when the
 * agent supplied no line numbers at all — the caller then withholds the hunk
 * affordance rather than emitting a bogus range.
 */
export function hunkLineRange(hunk: Pick<ChangesetHunk, "lines">): HunkRange | null {
  const news: number[] = [];
  const olds: number[] = [];
  const removed: number[] = [];
  let removedLineCount = 0;
  for (const l of hunk.lines ?? []) {
    // P2 review F7 — a non-positive number is not a line number. Collecting it
    // produced a {0,0} range that the (positive-constrained) scope schema then
    // rejected at the boundary, surfacing as a generic error toast. Filter here
    // and fall through to the existing withhold-the-affordance discipline.
    const isNum = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
    if (isNum(l.newLine)) news.push(l.newLine);
    if (isNum(l.oldLine)) olds.push(l.oldLine);
    if (l.kind === "del") {
      removedLineCount++;
      if (isNum(l.oldLine)) removed.push(l.oldLine);
    }
  }
  if (news.length > 0) {
    const range: HunkRange = { lineStart: Math.min(...news), lineEnd: Math.max(...news), side: "new" };
    // P2 review F2 — the removed lines of a MIXED hunk sit outside the new-side
    // range by construction (a deleted line has no new number), so a hunk that
    // is mostly deletions would deliver a range covering only the context lines
    // that survived. Carry the removals' pre-change envelope alongside.
    if (removed.length > 0) {
      range.oldStart = Math.min(...removed);
      range.oldEnd = Math.max(...removed);
      range.removedLineCount = removedLineCount;
    }
    return range;
  }
  // P2 review F1 — a PURE-DELETION hunk has only old-side numbers. They are
  // still worth sending (they are what the diff shows), but the side must be
  // explicit: the lines are gone from the working tree.
  if (olds.length > 0) {
    return {
      lineStart: Math.min(...olds),
      lineEnd: Math.max(...olds),
      side: "old",
      ...(removedLineCount > 0 ? { removedLineCount } : {}),
    };
  }
  return null;
}

export function WalkMeThroughButton({
  target,
  className,
  compact = false,
}: {
  /** What this click explains — drives the text, the scope data and the label. */
  target: WalkTarget;
  className?: string;
  /** Hunk-header variant: same affordance, tighter and quieter. */
  compact?: boolean;
}) {
  const submitRequest = useArtifactStore((s) => s.submitRequest);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const replayActive = useReplayStore((s) => s.active);
  const pushToast = useToastStore((s) => s.push);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const sentResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    // Set on every effect mount so React StrictMode's setup-cleanup-setup cycle
    // leaves the live instance enabled.
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (sentResetTimer.current !== null) clearTimeout(sentResetTimer.current);
    };
  }, []);

  // A request emitted during replay would land on the wrong (historical)
  // session, and submitRequest refuses it anyway — so the affordance is withheld.
  if (replayActive) return null;

  const requestText = buildWalkMeThroughRequest(target);
  const scope = buildWalkMeThroughScope(target);
  const label = walkMeThroughLabel(target);
  const ariaLabel = walkMeThroughAria(target);

  const onClick = async () => {
    if (sending) return;
    setSending(true);
    try {
      // P2 fix 3 — the prose AND the data. `source` marks this as a one-click
      // scoped ask (not a hand-typed composer request); `scope` is what the
      // agent scopes the explainer to (and links relatedArtifactIds at).
      await submitRequest(requestText, "explain", { source: "walk_me_through", scope });
      if (!mounted.current) return;
      setSent(true);
      if (sentResetTimer.current !== null) clearTimeout(sentResetTimer.current);
      sentResetTimer.current = setTimeout(() => {
        sentResetTimer.current = null;
        setSent(false);
      }, 2500);
      // Liveness-branched confirmation — the same predicate the request composer
      // uses, so the two surfaces can't disagree about whether an agent is live.
      // P2 fix 4 — both branches now name the DESTINATION: round 11 found nothing
      // on screen said WHERE the answer lands, so the click felt like a shout
      // into the void.
      if (noAgentLive(activeSessions)) {
        pushToast({
          kind: "info",
          title: "Saved — Claude will explain when the session resumes",
          body: "No agent is live. The request is queued in the Ask-Claude row; the explainer posts to the sidebar when you resume.",
        });
      } else {
        pushToast({
          kind: "success",
          title: "Sent to Claude",
          body: "Claude will post an explainer in the sidebar on its next check-in (about every 30s while working).",
        });
      }
    } catch {
      if (!mounted.current) return;
      /* store rolled back + toasted the error */
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={sending}
      // P2 — the testid names the GRAIN ("walk-me-through-file" /
      // "-hunk" / "-needs-eyes"): the round-11 finding was precisely that a
      // file-grain and a hunk-grain click were indistinguishable, and an
      // undifferentiated selector let that ship. `data-walk-grain` carries the
      // same fact for attribute-based (e2e) selection.
      data-testid={`walk-me-through-${target.kind}`}
      data-walk-grain={target.kind}
      aria-label={`${label} — ${ariaLabel}`}
      title={`Ask Claude to explain ${ariaLabel} — the explainer posts in the sidebar`}
      // P2 fix 4 (UX MED) — `font-sans` explicitly: inside the changeset's
      // font-mono file-path / hunk headers the button inherited the mono face and
      // read as file METADATA rather than an action. `shrink-0 whitespace-nowrap`
      // keeps it out of the path row's wrap flow (the header no longer grows to a
      // second 67px row on a deep path — the path truncates instead).
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-sans text-2xs font-medium
                  text-text-muted hover:text-accent-blue focus-visible:text-accent-blue focus-visible:outline-none
                  focus-visible:ring-1 focus-visible:ring-accent-blue rounded transition-colors
                  disabled:opacity-50 cursor-pointer ${compact ? "px-1" : "px-1 py-0.5"} ${className ?? ""}`}
    >
      {/* Q4 (round-12 UX #5) — the 🧭 was the last emoji on a primary control
          and rendered as tofu without a colour-emoji font, turning the
          walk-me-through affordance into "□ Explain this". Inline SVG in
          currentColor, so it follows the button's muted→blue hover. */}
      <span aria-hidden="true" className="flex items-center">
        {sent ? "✓" : <CompassIcon className="w-3 h-3" />}
      </span>
      <span>{sent ? "Sent — posting in the sidebar" : label}</span>
      {!sent && <span aria-hidden="true">▸</span>}
    </button>
  );
}
