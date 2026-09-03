import type { Artifact, Evidence, Comment, PlanVisual } from "@deeppairing/shared";
import { coerceResearchContent } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useChainComments } from "../../hooks/useChainComments";
import { scrollToAnchor } from "../../lib/comment-anchor";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { ArtifactVisuals } from "../ArtifactVisuals";
import { ConceptBadge } from "../ConceptBadge";
import { FileViewer } from "./FileViewer";
import { CommentableCode } from "../CommentableCode";
import { CommentTrigger, AskTrigger } from "../CommentThread";
import { useWriteLock } from "../../hooks/useWriteLock";
import { OpenQuestionSection } from "./OpenQuestionSection";
import { OpenInEditorLink } from "../OpenInEditor";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { useState, useMemo, useEffect } from "react";

interface ResearchArtifactProps {
  artifact: Artifact;
}

interface RichFinding {
  category: string;
  title?: string;
  detail: string;
  evidence: string | Evidence[];
  significance: "low" | "medium" | "high";
  severity?: "info" | "low" | "medium" | "high" | "critical";
  confidence?: "low" | "medium" | "high";
  impact?: string;
  recommendation?: string;
  /** R1 (#279) — "internal" means this one is for you, never for the PR. */
  audience?: "internal" | "postable";
  /** R4 P-A (#284) — the named pattern behind this finding → ledger-aware badge. */
  concept?: { name: string; oneLineExplanation?: string };
}

const severityStyles: Record<string, string> = {
  info: "bg-surface-elevated text-text-muted border border-white/[0.06]",
  low: "bg-accent-green-dim text-accent-green",
  medium: "bg-accent-amber-dim text-accent-amber",
  high: "bg-accent-red-dim text-accent-red",
  // Q4 review (L8) — the CRITICAL badge sits in the same finding row as the
  // verdict chips fixed above, on the same solid-accent fill, with the same
  // 3.35:1 literal white in the dark theme. Fixing the chips and leaving the
  // loudest badge in the row broken made the row inconsistent with itself.
  // (The remaining ~8 solid-accent `text-white` sites outside this row are
  // still deferred — same one-token fix, named in the PR.)
  critical: "bg-accent-red text-text-inverse",
};

const severityLabels: Record<string, string> = {
  info: "info",
  low: "low risk",
  medium: "medium risk",
  high: "high risk",
  critical: "critical",
};

const sigColors: Record<string, string> = {
  high: "bg-accent-red-dim text-accent-red",
  medium: "bg-accent-amber-dim text-accent-amber",
  low: "bg-surface-elevated text-text-secondary",
};

const categoryColors: Record<string, string> = {
  security: "bg-accent-red-dim text-accent-red",
  architecture: "bg-accent-violet-dim text-accent-violet",
  performance: "bg-accent-amber-dim text-accent-amber",
  testing: "bg-accent-cyan-dim text-accent-cyan",
  infrastructure: "bg-accent-blue-dim text-accent-blue",
  "code quality": "bg-accent-green-dim text-accent-green",
  domain: "bg-accent-violet-dim text-accent-violet",
};

function getCategoryColor(category: string): string {
  const lower = category.toLowerCase();
  // Check for partial matches (e.g., "Domain / Why This Exists" matches "domain")
  for (const [key, color] of Object.entries(categoryColors)) {
    if (lower.includes(key)) return color;
  }
  return "bg-accent-blue-dim text-accent-blue";
}

type ColorBy = "significance" | "category";

type Verdict = "approved" | "revised" | "rejected";

/** Latest verdict for one finding, derived from its verdict-section comments.
 *  Shared by FindingTriage (per-finding) and TriageProgressStrip (aggregate). */
function deriveVerdict(comments: Comment[], findingIndex: number): Verdict | null {
  const verdicts = comments.filter(
    (c) => c.target.sectionId === "verdict" && c.target.findingIndex === findingIndex,
  );
  const newest = verdicts[verdicts.length - 1];
  if (!newest) return null;
  const content = newest.content.toLowerCase();
  if (content.startsWith("approved")) return "approved";
  if (content.startsWith("needs revision")) return "revised";
  if (content.startsWith("rejected")) return "rejected";
  return null;
}

const VERDICT_CHIP: Record<Verdict, string> = {
  approved: "bg-accent-green",
  revised: "bg-accent-amber",
  rejected: "bg-accent-red",
};

/**
 * C5 — shared triage progress. Reviewing a 10-finding artifact had no joint
 * state: verdicts vanished into per-finding comments and nothing said "3/10
 * reviewed" or took you to the next unreviewed one — the review felt like
 * leaving sticky notes in a drawer. One chip per finding (color = verdict,
 * hollow = unreviewed), click to jump, plus a next-unreviewed fast path.
 */
function TriageProgressStrip({
  findings,
  comments,
  onJump,
}: {
  findings: RichFinding[];
  comments: Comment[];
  onJump: (index: number) => void;
}) {
  // D6 (P4) — memoized, and the <3 bail happens INSIDE the memo (hooks must
  // run unconditionally) so small artifacts skip the O(findings × comments)
  // scan entirely. Hygiene at typical sizes; matters on huge artifacts.
  const verdicts = useMemo(
    () => (findings.length < 3 ? [] : findings.map((_, i) => deriveVerdict(comments, i))),
    [findings, comments],
  );
  if (findings.length < 3) return null;
  const reviewed = verdicts.filter(Boolean).length;
  const nextUnreviewed = verdicts.findIndex((v) => v === null);

  return (
    <div className="flex items-center gap-2 flex-wrap rounded border border-border-default bg-surface-elevated/50 px-2.5 py-1.5">
      <span className="text-2xs text-text-secondary font-medium shrink-0" aria-live="polite">
        Reviewed {reviewed} / {findings.length}
      </span>
      {/* role=group (not list): listitem on a <button> would OVERRIDE its
          implicit button role and hide it from AT + role queries. */}
      <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Finding verdicts">
        {verdicts.map((v, i) => (
          <button
            key={i}
            onClick={() => onJump(i)}
            title={`Finding ${i + 1}: ${findings[i]?.title ?? ""} — ${v ?? "not reviewed"}`}
            aria-label={`Finding ${i + 1}: ${v ?? "not reviewed"}`}
            className={`w-2.5 h-2.5 rounded-full transition-colors press-scale ${
              v ? VERDICT_CHIP[v] : "border border-text-muted/50 bg-transparent hover:bg-surface-hover"
            }`}
          />
        ))}
      </div>
      {nextUnreviewed >= 0 && reviewed > 0 && (
        <button
          onClick={() => onJump(nextUnreviewed)}
          className="ml-auto text-2xs text-accent-blue hover:underline shrink-0"
        >
          Next unreviewed →
        </button>
      )}
    </div>
  );
}

/**
 * Per-finding triage chips. When auditing a research artifact with many
 * findings, binary artifact-level Approve/Revise is too coarse — you want
 * to accept findings 1, 3, 5 and push back on 2 and 4. This submits a
 * finding-scoped comment the agent can use when supersedes.
 */
function FindingTriage({
  artifactId,
  findingIndex,
  findingTitle,
  comments,
  locked = false,
}: {
  artifactId: string;
  findingIndex: number;
  findingTitle: string;
  comments: Comment[];
  /** #204 (UX L2) — a retracted/terminal (useWriteLock "closed") or replayed
   *  ("frozen") artifact is READ-ONLY on the write axis: the verdict triad stays
   *  VISIBLE (the prior verdict is history) but dimmed + non-interactive, never a
   *  live-looking glyph you can click on a draft the agent already took back. */
  locked?: boolean;
}) {
  const [promptVerdict, setPromptVerdict] = useState<Verdict | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submitComment = useArtifactStore((s) => s.submitComment);

  // C5 review — REAL single-sourcing: consume the shared deriveVerdict (the
  // strip and the chip previously ran near-duplicate derivations over
  // different comment subsets — a divergence door if a verdict comment ever
  // carried evidence fields).
  const latestVerdict = useMemo<Verdict | null>(
    () => deriveVerdict(comments, findingIndex),
    [comments, findingIndex],
  );

  const submit = async (verdict: Verdict, reasonText = "") => {
    if (submitting || locked) return; // #204 — a locked (closed/frozen) triad never writes.
    setSubmitting(true);
    try {
      const label =
        verdict === "approved" ? "Approved" :
        verdict === "revised" ? "Needs revision" :
        "Rejected";
      const body = reasonText.trim() ? `${label}: ${reasonText.trim()}` : `${label} — finding #${findingIndex + 1}`;
      await submitComment(
        artifactId,
        body,
        { findingIndex, sectionId: "verdict" } as any,
      );
      setPromptVerdict(null);
      setReason("");
    } catch {
      // C1 — the store re-throws after toasting; uncaught this surfaced as an
      // unhandled rejection. Keep the popover open (verdict + reason intact)
      // so the user can retry.
    } finally {
      setSubmitting(false);
    }
  };

  const chipClass = (active: boolean, tone: "green" | "amber" | "red") => {
    const base = "w-5 h-5 flex items-center justify-center rounded text-[10px] font-semibold transition-colors press-scale";
    if (active) {
      // Q4 (round-12 UX #3/#5) — the ACTIVE verdict chip is the one place the
      // finding row states your decision, and it stated it in literal white on
      // a saturated fill: 2.54:1 green, 2.24:1 amber, 3.35:1 red in the dark
      // theme (light was fine, which is how it survived). `text-text-inverse`
      // is the token the other solid-accent buttons already use and it flips
      // with the theme — 7.43 / 8.41 / 5.63 dark, 5.80 / 6.31 / 6.19 light.
      // (The plain accents have no `-strong` variant; on `-strong` fills
      // literal white IS correct and must stay — see blue/violet-strong.)
      return `${base} ${
        tone === "green" ? "bg-accent-green text-text-inverse" :
        tone === "amber" ? "bg-accent-amber text-text-inverse" :
        "bg-accent-red text-text-inverse"
      }`;
    }
    return `${base} text-text-muted hover:text-text-primary ${
      tone === "green" ? "hover:bg-accent-green-dim" :
      tone === "amber" ? "hover:bg-accent-amber-dim" :
      "hover:bg-accent-red-dim"
    }`;
  };

  return (
    <div
      className={`relative flex items-center gap-0.5 ${locked ? "opacity-40" : ""}`}
      // Q4 (round-12 UX #5) — the three chips are glyph-only (✓ ↻ ✗) and each
      // one already names ITSELF, but nothing named the SET, so a screen reader
      // met three unexplained buttons with no clue they were one choice. A
      // group + a name is the whole fix; visible labels would triple the width
      // of a row that already carries severity, confidence, Ask and Comment.
      // (role=group, not a bare aria-label: aria-label on a generic <div> is
      // prohibited and gets dropped.)
      role="group"
      aria-label={`Your verdict on finding ${findingIndex + 1}`}
      // #204 (UX L2) — dim + inert on a closed/frozen artifact. aria-disabled +
      // per-button disabled keeps keyboard users out too (opacity alone wouldn't).
      aria-disabled={locked || undefined}
      title={locked ? "Read-only — this artifact was retracted or is being replayed" : undefined}
    >
      <button
        onClick={() => submit("approved")}
        disabled={submitting || locked}
        aria-label={`Approve finding ${findingIndex + 1}`}
        title={locked ? undefined : `Approve — "${findingTitle.slice(0, 60)}"`}
        className={chipClass(latestVerdict === "approved", "green")}
      >
        ✓
      </button>
      <button
        onClick={() => {
          setPromptVerdict("revised");
          setReason("");
        }}
        disabled={submitting || locked}
        aria-label={`Request changes on finding ${findingIndex + 1}`}
        title={locked ? undefined : "Request changes — needs a reason"}
        className={chipClass(latestVerdict === "revised", "amber")}
      >
        ↻
      </button>
      <button
        onClick={() => {
          setPromptVerdict("rejected");
          setReason("");
        }}
        disabled={submitting || locked}
        aria-label={`Reject finding ${findingIndex + 1}`}
        title={locked ? undefined : "Reject — needs a reason"}
        className={chipClass(latestVerdict === "rejected", "red")}
      >
        ✗
      </button>

      {!locked && promptVerdict && (
        <div className="absolute top-full right-0 mt-1 p-2 bg-surface-elevated border border-border-default rounded-lg shadow-lg z-10 w-72">
          <div className="text-2xs text-text-muted mb-1.5">
            {promptVerdict === "revised" ? "Why should the agent revise?" : "Why reject?"}
          </div>
          <textarea
            rows={2}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reason.trim()) {
                e.preventDefault();
                submit(promptVerdict, reason);
              }
              if (e.key === "Escape") {
                setPromptVerdict(null);
                setReason("");
              }
            }}
            placeholder={`Reason (${promptVerdict === "revised" ? "agent redrafts this finding" : "remembered across sessions"})…`}
            className="w-full px-2 py-1.5 bg-surface-secondary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none"
          />
          <div className="flex gap-1.5 mt-1.5 justify-end">
            <button
              onClick={() => { setPromptVerdict(null); setReason(""); }}
              className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary"
            >
              Cancel
            </button>
            <button
              onClick={() => submit(promptVerdict, reason)}
              disabled={!reason.trim() || submitting}
              // Q4 — same pair as the verdict chips above (2.24:1 amber /
              // 3.35:1 red on dark); text-text-inverse is theme-aware.
              className={`px-2 py-1 text-2xs text-text-inverse rounded press-scale disabled:opacity-50 ${
                promptVerdict === "revised" ? "bg-accent-amber hover:bg-accent-amber/80" : "bg-accent-red hover:bg-accent-red/80"
              }`}
            >
              {promptVerdict === "revised" ? "Request changes" : "Reject"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FindingLegend({ colorBy, findings }: { colorBy: ColorBy; findings: RichFinding[] }) {
  if (colorBy === "significance") {
    return (
      <div className="flex items-center gap-3 text-2xs text-text-muted">
        <span className="text-text-muted">Color:</span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded bg-accent-red" /> High
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded bg-accent-amber" /> Medium
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded bg-text-muted" /> Low
        </span>
      </div>
    );
  }

  // Category mode — show unique categories found in findings
  const categories = [...new Set(findings.map((f) => f.category).filter(Boolean))];
  return (
    <div className="flex items-center gap-3 text-2xs text-text-muted flex-wrap">
      <span className="text-text-muted">Color:</span>
      {categories.map((cat) => (
        <span key={cat} className="flex items-center gap-1">
          <span className={`w-2 h-2 rounded ${getCategoryColor(cat).split(" ")[0]}`} />
          {cat}
        </span>
      ))}
    </div>
  );
}

// Exported so other narrative artifacts (the #190 DEBRIEF sections) reuse the
// exact Evidence + CommentableCode wiring instead of duplicating the
// commentsByLine bucketing + FileViewer plumbing. The debrief passes its
// section index as `findingIndex` (a debrief has no findings, so the namespace
// is its own) so line comments anchor via the same generic findingIndex/
// evidenceIndex target the server already delivers.
export function EvidenceItem({
  evidence,
  artifactId,
  findingIndex,
  evidenceIndex,
  allComments,
  readOnly = false,
}: {
  // U2 — Evidence.filePath/lineStart are optional at the schema now (docs anchor
  // via `locator`), but EvidenceItem is the LINE-ANCHORED code renderer and is
  // only routed evidence with a numeric lineStart (renderEvidence gates on it).
  // The intersection makes lineStart non-optional so the gutter/OpenInEditor
  // stay typed; filePath is still guarded at its two string-required uses.
  evidence: Evidence & { lineStart: number };
  artifactId: string;
  findingIndex: number;
  evidenceIndex: number;
  allComments: Comment[];
  /** #204 (UX L2) — suppress the evidence AskTrigger + make the code gutters
   *  read-only when the parent artifact is retracted/terminal or replayed. */
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showFullFile, setShowFullFile] = useState(false);

  // Build a map of comments by line number for this evidence.
  //
  // Span comments (lineStart != lineEnd) bucket into EVERY line in the
  // range. CommentableCode then renders the full comment chip on the
  // start line and a compact "↳ continues from L{N}" marker on
  // subsequent lines — so a comment spanning lines 5-8 is visible on all
  // four lines, not just line 5 (which was the visibility bug).
  //
  // Defensive: a single malformed comment target (string lineStart,
  // negative range, undefined fields, etc.) must not blow up the entire
  // artifact render. Coerce-and-validate per comment, skip the bad one,
  // keep going.
  const commentsByLine = useMemo(() => {
    const map = new Map<number, Comment[]>();
    for (const c of allComments) {
      try {
        if (
          c.target?.findingIndex !== findingIndex ||
          c.target?.evidenceIndex !== evidenceIndex ||
          c.target?.lineStart == null
        ) continue;
        const startN = Number(c.target.lineStart);
        const endRaw = c.target.lineEnd;
        const endN = endRaw == null ? startN : Number(endRaw);
        // Skip bad numerics rather than crashing the render.
        if (!Number.isFinite(startN) || !Number.isFinite(endN)) continue;
        const start = Math.max(0, Math.floor(startN));
        const end = Math.max(start, Math.floor(endN));
        // Cap span at 200 lines so a runaway lineEnd can't blow the Map up.
        const safeEnd = Math.min(end, start + 200);
        for (let line = start; line <= safeEnd; line++) {
          const existing = map.get(line) ?? [];
          existing.push(c);
          map.set(line, existing);
        }
      } catch {
        // Ignore one bad comment; keep rendering the rest of the artifact.
      }
    }
    return map;
  }, [allComments, findingIndex, evidenceIndex]);

  return (
    <>
      {showFullFile && evidence.filePath && (
        <FileViewer
          filePath={evidence.filePath}
          highlightStart={evidence.lineStart}
          highlightEnd={evidence.lineEnd}
          artifactId={artifactId}
          onClose={() => setShowFullFile(false)}
        />
      )}
      <div className="mt-2 rounded-md overflow-hidden border border-border-default">
        {/* File header */}
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-surface-elevated text-xs">
          <span className="font-mono text-text-secondary flex items-center gap-1.5">
            {evidence.filePath}:{evidence.lineStart}-{evidence.lineEnd}
            {evidence.filePath && <OpenInEditorLink filePath={evidence.filePath} line={evidence.lineStart} />}
          </span>
          <div className="flex items-center gap-2">
            {!readOnly && (
              <AskTrigger
                artifactId={artifactId}
                target={{ findingIndex, evidenceIndex }}
              />
            )}
            <button
              onClick={() => setShowFullFile(true)}
              className="text-text-muted hover:text-accent-blue transition-colors"
              title="Open full file"
            >
              Open file
            </button>
            {evidence.relatedPaths && evidence.relatedPaths.length > 0 && (
              <span className="text-text-muted">+{evidence.relatedPaths.length} related</span>
            )}
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-text-muted hover:text-text-muted"
            >
              {expanded ? "▼" : "▶"}
            </button>
          </div>
        </div>

        {/* Commentable code snippet — hover line to see +, click to comment */}
        {evidence.snippet && (
          <CommentableCode
            code={evidence.snippet}
            language={evidence.language}
            lineStart={evidence.lineStart}
            filePath={evidence.filePath}
            artifactId={artifactId}
            commentsByLine={commentsByLine}
            targetContext={{ findingIndex, evidenceIndex }}
            readOnly={readOnly}
          />
        )}

        {/* Explanation */}
        <div className="px-3 py-2 bg-accent-amber-dim/80 border-t border-border-default/20 text-xs text-text-secondary">
          {evidence.explanation}
        </div>

        {/* Expanded: context + related paths */}
        {expanded && (
          <>
            {evidence.context && (
              <div className="border-t border-border-default">
                <div className="px-2.5 py-1 bg-surface-elevated text-[10px] font-semibold text-text-muted uppercase">
                  Full Context
                </div>
                <CommentableCode
                  code={evidence.context}
                  lineStart={1}
                  filePath={evidence.filePath}
                  artifactId={artifactId}
                  targetContext={{ findingIndex, evidenceIndex }}
                  readOnly={readOnly}
                />
              </div>
            )}
            {evidence.relatedPaths && evidence.relatedPaths.length > 0 && (
              <div className="px-3 py-2 border-t border-border-default text-xs bg-surface-secondary">
                <span className="font-medium text-text-muted">Also appears in: </span>
                {evidence.relatedPaths.map((p) => (
                  <span key={p} className="inline-block px-1.5 py-0.5 bg-gray-200 rounded font-mono text-text-secondary mr-1">
                    {p}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * U2 (round-15 generalization) — the NON-CODE sibling of EvidenceItem. A
 * doc/message/design passage has no file:line, so it can't render through the
 * line-numbered code gutter — but the flagship "comment on the exact passage"
 * affordance must survive. This renders the passage as a QUOTED block with a
 * per-passage Comment + Ask affordance anchored to {findingIndex, evidenceIndex}
 * (the same target lane EvidenceItem's AskTrigger uses), so the human still
 * comments on the exact passage instead of the evidence degrading to prose.
 *
 * Anchor label comes from the optional `locator` ({ kind, value, ... }): a quote
 * excerpt, a heading path ("§5 ¶3"), a char range, or a URL. A `url` locator is
 * rendered as a link ONLY for http(s) — a javascript:/data: value renders as
 * inert text (all values are React text nodes, so they're already escaped).
 */
export function PassageEvidenceItem({
  evidence,
  artifactId,
  findingIndex,
  evidenceIndex,
  allComments,
  readOnly = false,
}: {
  evidence: Partial<Evidence>;
  artifactId: string;
  findingIndex: number;
  evidenceIndex: number;
  allComments: Comment[];
  readOnly?: boolean;
}) {
  const locator = evidence.locator;
  // The passage text: prefer an explicit snippet, else a quote locator's value.
  const passage =
    typeof evidence.snippet === "string" && evidence.snippet.length > 0
      ? evidence.snippet
      : locator?.kind === "quote"
        ? locator.value
        : "";

  // Anchor label — WHERE this passage lives, shown in the header.
  let anchorLabel: string | null = null;
  let anchorHref: string | null = null;
  if (locator) {
    if (locator.kind === "heading") anchorLabel = locator.value;
    else if (locator.kind === "charRange") anchorLabel = `chars ${locator.value}`;
    else if (locator.kind === "url") {
      anchorLabel = locator.value;
      const link = locator.href ?? locator.value;
      // Only http(s) links are made clickable — never javascript:/data: etc.
      if (typeof link === "string" && /^https?:\/\//i.test(link)) anchorHref = link;
    } else if (locator.kind === "quote" && passage !== locator.value) {
      // A quote used purely as the anchor (passage came from snippet).
      anchorLabel = `❝ ${locator.value}`;
    }
  }
  if (!anchorLabel && typeof evidence.filePath === "string" && evidence.filePath.length > 0) {
    anchorLabel = evidence.filePath;
  }

  // Existing comments pinned to THIS passage (findingIndex + evidenceIndex, no
  // line) → drives the CommentTrigger count.
  const existing = allComments.filter(
    (c) =>
      c.target?.findingIndex === findingIndex &&
      c.target?.evidenceIndex === evidenceIndex &&
      c.target?.lineStart == null,
  ).length;

  return (
    <div className="mt-2 rounded-md overflow-hidden border border-border-default">
      {/* Passage header — the non-code anchor + comment/ask affordances */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-surface-elevated text-xs">
        <span className="min-w-0 flex items-center gap-1.5 text-text-secondary">
          <span className="shrink-0 px-1 py-px rounded text-[10px] bg-surface-secondary text-text-muted uppercase tracking-wide">
            {locator?.kind ?? "passage"}
          </span>
          {anchorHref ? (
            <a
              href={anchorHref}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-accent-blue hover:underline"
            >
              {anchorLabel}
            </a>
          ) : (
            anchorLabel && <span className="truncate text-text-secondary">{anchorLabel}</span>
          )}
        </span>
        {!readOnly && (
          <div className="flex items-center gap-2 shrink-0">
            <CommentTrigger
              artifactId={artifactId}
              target={{ findingIndex, evidenceIndex }}
              existingCount={existing}
              label="Comment on this passage"
            />
            <AskTrigger artifactId={artifactId} target={{ findingIndex, evidenceIndex }} />
          </div>
        )}
      </div>

      {/* The quoted passage — a blockquote, NOT a code gutter. */}
      {passage && (
        <blockquote className="px-3 py-2 border-l-2 border-accent-blue/40 bg-surface-code/60 text-xs text-text-primary whitespace-pre-wrap break-words">
          {passage}
        </blockquote>
      )}

      {/* Explanation — why this passage matters. */}
      {evidence.explanation && (
        <div className="px-3 py-2 bg-accent-amber-dim/80 border-t border-border-default/20 text-xs text-text-secondary">
          {evidence.explanation}
        </div>
      )}
    </div>
  );
}

// Exported alongside EvidenceItem so the debrief's section evidence renders
// through the identical string|Evidence[] handling (reuse, not rebuild).
export function renderEvidence(
  evidence: unknown,
  artifactId: string,
  findingIndex: number,
  allComments: Comment[],
  // #204 (UX L2) — read-only threads the write-lock down to the evidence gutter +
  // its AskTrigger. Defaults false so the debrief's reuse of this helper (and any
  // other caller) is byte-unchanged.
  readOnly = false,
) {
  // Guard: missing or null evidence
  if (!evidence) return null;

  // String evidence (simple reference)
  if (typeof evidence === "string") {
    return <p className="text-text-muted mt-0.5 font-mono text-[11px]">{evidence}</p>;
  }

  // Normalize: single object → wrap in array
  const evidenceArray = Array.isArray(evidence) ? evidence : [evidence];

  return (
    <div className="space-y-1">
      {evidenceArray.map((ev, evIdx) => {
        // D7 — string elements in mixed arrays are schema-legal and now
        // actually reach here (the coercer used to drop them); render them
        // as plain refs, not JSON-quoted.
        if (typeof ev === "string") {
          return (
            <p key={evIdx} className="text-text-muted mt-0.5 font-mono text-[11px]">
              {ev}
            </p>
          );
        }
        // Guard: skip items that aren't objects at all.
        if (!ev || typeof ev !== "object") {
          return (
            <p key={evIdx} className="text-text-muted mt-0.5 font-mono text-[11px]">
              {JSON.stringify(ev)}
            </p>
          );
        }
        const e = ev as Partial<Evidence>;
        // U2 — LINE-anchored code evidence (every legacy Evidence carries a
        // numeric lineStart) → the unchanged line-numbered gutter. Byte-identical
        // routing for all existing findings (the back-compat gate).
        if (typeof e.lineStart === "number") {
          return (
            <EvidenceItem
              key={evIdx}
              evidence={ev as Evidence & { lineStart: number }}
              artifactId={artifactId}
              findingIndex={findingIndex}
              evidenceIndex={evIdx}
              allComments={allComments}
              readOnly={readOnly}
            />
          );
        }
        // U2 — a NON-code passage (doc / message / design): anchored by a
        // `locator`, or a bare passage with no line grain. Render it as a
        // QUOTED, per-passage-COMMENTABLE block — the flagship
        // comment-on-the-exact-passage affordance survives for docs instead of
        // degrading to prose.
        if (e.locator || typeof e.snippet === "string" || typeof e.filePath === "string") {
          return (
            <PassageEvidenceItem
              key={evIdx}
              evidence={e}
              artifactId={artifactId}
              findingIndex={findingIndex}
              evidenceIndex={evIdx}
              allComments={allComments}
              readOnly={readOnly}
            />
          );
        }
        // Genuine junk (no anchor, no passage) — last-resort dump, as before.
        return (
          <p key={evIdx} className="text-text-muted mt-0.5 font-mono text-[11px]">
            {JSON.stringify(ev)}
          </p>
        );
      })}
    </div>
  );
}

export function ResearchArtifact({ artifact }: ResearchArtifactProps) {
  // Coercion boundary: turn raw/partial/legacy content into a fully-shaped
  // ResearchContent (every finding an object, findings an array) so the
  // renderer can trust the shape. RichFinding is the local view type — it adds
  // the UI-only `confidence` the coercer preserves and narrows `evidence`.
  // D6 review — memoize the coercion at the SOURCE: unmemoized it built a
  // fresh findings array every render, which made every downstream
  // [findings]-keyed memo (the triage strip's included) decorative — and on
  // huge artifacts the re-coerce itself was the bigger per-render cost.
  const content = useMemo(
    () =>
      coerceResearchContent(artifact.content) as {
        summary: string;
        findings: RichFinding[];
        openQuestions?: string[];
        visuals?: PlanVisual[];
      },
    [artifact.content],
  );
  const comments = useChainComments(artifact.id); // Bug2 — chain aggregation
  // #204 (UX L2) — the WRITE AXIS, via the shared useWriteLock hook (not an
  // ad-hoc `status === "retracted"`), so a retracted (→ "closed") or replayed (→
  // "frozen") artifact locks the per-finding verdict triad + the comment/ask
  // composers uniformly. Draft ("review") and approved ("follow_up") stay fully
  // writable — follow-up commenting is intact.
  const writeLocked = useWriteLock(artifact.status);
  const [focusMode, setFocusMode] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [colorBy, setColorBy] = useState<ColorBy>("significance");
  const findings = content.findings;
  // A revision can shrink `findings` under a stale focusIndex — render
  // nothing for that frame instead of crashing (line 769 already hedged
  // the title lookup for the same reason).
  // F5 review — clamp rather than skip: a revision shrinking findings under
  // a stale focusIndex left the pane EMPTY with a "5 / 3" counter until the
  // user navigated. Showing the last finding is strictly better.
  const focusedFinding = findings[Math.min(focusIndex, findings.length - 1)];

  // Arrow key navigation in focus mode
  useEffect(() => {
    if (!focusMode) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex((i) => Math.min(findings.length - 1, i + 1));
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [focusMode, findings.length]);

  const renderFinding = (finding: RichFinding, i: number) => {
    const findingComments = comments.filter(
      (c) => c.target.findingIndex === i && c.target.evidenceIndex == null && c.target.lineStart == null,
    );
    return (
      <div
        key={i}
        // X10 — landing target for `dp:focus-artifact` events that carry a
        // finding-level anchor. See lib/comment-anchor.ts.
        data-comment-anchor={`finding:${i}`}
        className={`bg-surface-secondary rounded-lg border border-white/[0.06] hover:border-white/[0.1] transition-all duration-[180ms] ease-out ${
          focusMode ? "p-5" : "p-3"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-medium ${
              colorBy === "significance"
                ? (sigColors[finding.significance] ?? "bg-surface-elevated text-text-secondary")
                : getCategoryColor(finding.category ?? "")
            }`}>
              {finding.category ?? "Finding"}
            </span>
            {finding.title && (
              <span className={`font-semibold text-text-primary ${focusMode ? "text-base" : "text-sm"}`}>{finding.title}</span>
            )}
            {finding.severity && (
              <span
                className={`shrink-0 px-1.5 py-0.5 rounded text-2xs font-semibold ${severityStyles[finding.severity]}`}
                title="Severity — risk level if unaddressed"
              >
                {severityLabels[finding.severity]}
              </span>
            )}
            {finding.confidence && finding.confidence !== "medium" && (
              <span className={`shrink-0 px-1.5 py-0.5 rounded text-2xs font-medium ${
                finding.confidence === "low"
                  ? "bg-accent-amber-dim text-accent-amber border border-dashed border-accent-amber/30"
                  : "bg-accent-green-dim text-accent-green"
              }`}>
                {finding.confidence === "low" ? "? uncertain" : "✓ confident"}
              </span>
            )}
            {/* R1 (#279) — the quiet promise. Approving a finding in a
                PR-review session arms it for someone else's repository, so a
                finding that is NOT going there has to say so where the verdict
                is given. Deliberately understated (muted, dashed) — it is a
                reassurance, not a warning. */}
            {finding.audience === "internal" && (
              <span
                className="shrink-0 px-1.5 py-0.5 rounded text-2xs font-medium bg-surface-elevated text-text-muted border border-dashed border-white/[0.14]"
                title="Internal — for you only. This finding is never posted to the PR, even if you approve the artifact."
              >
                internal — won't be posted
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <FindingTriage
              artifactId={artifact.id}
              findingIndex={i}
              findingTitle={finding.title ?? finding.detail}
              comments={findingComments}
              locked={writeLocked}
            />
            {/* #204 (UX L2) — the ask/comment COMPOSERS are pure write affordances;
                on a closed/frozen artifact they're withheld (a disabled "Ask" has
                no value). Posted comment history still renders below — read-only. */}
            {!writeLocked && (
              <>
                <AskTrigger
                  artifactId={artifact.id}
                  target={{ findingIndex: i }}
                />
                <CommentTrigger
                  artifactId={artifact.id}
                  target={{ findingIndex: i }}
                  existingCount={findingComments.length}
                />
              </>
            )}
          </div>
        </div>

        {/* Detail */}
        <SimpleMarkdown text={finding.detail} className={`prose-field text-text-secondary mt-2 space-y-2 ${focusMode ? "text-sm leading-relaxed" : "text-xs"}`} />

        {/* R4 P-A (#284) — the named pattern behind this finding. The badge is
            the CTA: it is ledger-aware (recurrence count + your stance) and
            clicking it opens the ledger drawer at the matching row — the learning
            moment that /review-pr's ledger sweep used to route through the deadest
            type (log_reasoning), now on the surface people actually read. */}
        {finding.concept?.name && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            <ConceptBadge name={finding.concept.name} explanation={finding.concept.oneLineExplanation} size="md" />
          </div>
        )}

        {/* Evidence — now with inline commenting on code lines (read-only when the
            artifact is retracted/terminal or being replayed). */}
        {renderEvidence(finding.evidence, artifact.id, i, comments, writeLocked)}

        {/* Impact */}
        {finding.impact && (
          <div className="mt-3 p-2.5 bg-accent-red-dim/50 border-l-2 border-accent-red rounded-r">
            <span className={`font-semibold text-accent-red block mb-0.5 ${focusMode ? "text-sm" : "text-xs"}`}>Impact</span>
            {/* R2 (contrast) — `text-accent-red/80` on the red-dim/50 wash
                measured 3.81:1 dark / 4.14:1 light. The label above it is
                already the solid token; the alpha bought nothing but a sub-AA
                body. Solid: 5.27 / 5.56. */}
            <SimpleMarkdown text={finding.impact} className={`prose-field text-accent-red ${focusMode ? "text-sm" : "text-xs"}`} />
          </div>
        )}

        {/* Recommendation */}
        {finding.recommendation && (
          <div className="mt-2 p-2.5 bg-accent-green-dim/50 border-l-2 border-accent-green rounded-r">
            <span className={`font-semibold text-accent-green block mb-0.5 ${focusMode ? "text-sm" : "text-xs"}`}>Recommendation</span>
            {/* R2 (contrast) — same class as Impact above: `text-accent-green/80`
                measured 4.45:1 dark / 3.67:1 light on the green-dim/50 wash.
                Solid: 6.15 / 5.39. */}
            <SimpleMarkdown text={finding.recommendation} className={`prose-field text-accent-green ${focusMode ? "text-sm" : "text-xs"}`} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {content.summary && (
        <SimpleMarkdown text={content.summary} className="prose-field text-sm text-text-secondary space-y-2" />
      )}

      {/* R4 P-B (#284) — visuals framing the research (an architecture diagram,
          a "shape of the system" file map). Self-hides when there are none; the
          shared component gives region-comments for free. Before R4 these were
          silently stripped at schema parse. */}
      <ArtifactVisuals artifactId={artifact.id} visuals={content.visuals ?? []} readOnly={writeLocked} />

      {findings.length > 0 && (
        <div className="space-y-3">
          {/* Header with view toggle and color mode */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                Findings ({findings.length})
              </h3>
              <div className="flex items-center gap-2">
                {/* Color by toggle */}
                <div className="flex items-center gap-0.5 bg-surface-elevated rounded p-0.5">
                  <button
                    onClick={() => setColorBy("significance")}
                    className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                      colorBy === "significance" ? "bg-surface-hover text-text-primary" : "text-text-muted"
                    }`}
                  >
                    Severity
                  </button>
                  <button
                    onClick={() => setColorBy("category")}
                    className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                      colorBy === "category" ? "bg-surface-hover text-text-primary" : "text-text-muted"
                    }`}
                  >
                    Category
                  </button>
                </div>
                {/* View mode toggle */}
                {findings.length > 1 && (
                  <div className="flex items-center gap-0.5 bg-surface-elevated rounded p-0.5">
                    <button
                      onClick={() => { setFocusMode(false); }}
                      className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                        !focusMode ? "bg-surface-hover text-text-primary" : "text-text-muted"
                      }`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => { setFocusMode(true); setFocusIndex(0); }}
                      className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                        focusMode ? "bg-surface-hover text-text-primary" : "text-text-muted"
                      }`}
                    >
                      Focus
                    </button>
                  </div>
                )}
              </div>
            </div>
            {/* Legend */}
            <FindingLegend colorBy={colorBy} findings={findings} />
          </div>

          {/* C5 — shared triage progress (jump: focus mode retargets the
              carousel; all mode scrolls to the finding's anchor). */}
          <TriageProgressStrip
            findings={findings}
            comments={comments}
            onJump={(i) => {
              if (focusMode) {
                setFocusIndex(i);
              } else {
                // C5 review — the scoped helper, not a bare querySelector:
                // during AnimatePresence transitions two artifacts coexist
                // (X10) and an unscoped match can hit the exiting one.
                scrollToAnchor(artifact.id, `finding:${i}`);
              }
            }}
          />

          {focusMode ? (
            /* Focus mode: one finding at a time with navigation */
            <div className="space-y-3">
              {/* Navigation */}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setFocusIndex((i) => Math.max(0, i - 1))}
                  disabled={focusIndex === 0}
                  className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary disabled:opacity-30 press-scale"
                >
                  Prev
                </button>
                <span className="text-2xs text-text-muted">
                  {focusIndex + 1} / {findings.length}
                  {findings[focusIndex]?.title && (
                    <span className="text-text-secondary ml-1.5">— {findings[focusIndex].title}</span>
                  )}
                </span>
                <button
                  onClick={() => setFocusIndex((i) => Math.min(findings.length - 1, i + 1))}
                  disabled={focusIndex === findings.length - 1}
                  className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary disabled:opacity-30 press-scale"
                >
                  Next
                </button>
              </div>

              {focusedFinding && renderFinding(focusedFinding, focusIndex)}

              {/* Dot indicators.
                  Q4 (round-12 UX #5) — these are 6px buttons with NO text, no
                  title and no label: a screen reader announced N nameless
                  buttons, and a pointer user got no hint of where each one
                  goes. Name them (the same shape the triage strip above
                  already uses) and mark the current one. */}
              <div className="flex items-center justify-center gap-1.5" role="group" aria-label="Jump to finding">
                {findings.map((f, i) => (
                  <button
                    key={i}
                    onClick={() => setFocusIndex(i)}
                    title={`Finding ${i + 1}${f.title ? `: ${f.title}` : ""}`}
                    aria-label={`Go to finding ${i + 1} of ${findings.length}`}
                    aria-current={i === focusIndex ? "true" : undefined}
                    className={`w-1.5 h-1.5 rounded-full transition-colors ${
                      i === focusIndex ? "bg-accent-blue-strong" : "bg-surface-hover"
                    }`}
                  />
                ))}
              </div>
            </div>
          ) : (
            /* List mode: all findings */
            <div className="space-y-4">
              {findings.map((finding, i) => renderFinding(finding, i))}
            </div>
          )}
        </div>
      )}

      {content.openQuestions && content.openQuestions.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
            Open Questions ({content.openQuestions.length})
          </h3>
          {/* #164 — each question is its own bounded section with a prominent
              answer affordance + inline thread (was a cramped list row). D8
              (H1) targeting per question (questionIndex) is preserved inside
              the shared component. */}
          {content.openQuestions.map((q, i) => (
            <OpenQuestionSection key={i} artifactId={artifact.id} question={q} index={i} readOnly={writeLocked} />
          ))}
        </div>
      )}

      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
