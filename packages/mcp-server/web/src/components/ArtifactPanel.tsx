import { useMemo, useState, useEffect, useRef, lazy, Suspense, type ReactNode } from "react";
// B5 — `m` + LazyMotion (App loads domAnimation) instead of the full
// `motion` component: drops ~40kB gzip of animation features nothing uses
// from the ENTRY bundle. Same animations.
import { m, AnimatePresence } from "motion/react";
import { apiGet, apiBase } from "../lib/api";
import type { Artifact, Comment } from "@deeppairing/shared";
import { useArtifactStore, resolveToLiveId, artifactStoreGeneration, markBackfilled, isBackfilled, REFRESH_SESSION_EVENT } from "../stores/artifact";
import { usePreferencesStore, SIDEBAR_WIDTHS } from "../stores/preferences";
import { useReplayStore } from "../stores/replay";
import { useConnectionStore } from "../stores/connection";
import { reviewLifecycle } from "../lib/reviewLifecycle";
import { isDraftAwaitingReview } from "../lib/pending";
import { useIsNarrowViewport, useMediaQuery } from "../hooks/useMediaQuery";
// D6 (P2) — the artifact renderers are LAZY: statically importing all seven
// kept them (and, via their coerce*Content imports, the whole Zod runtime)
// in the entry chunk. Each renderer now code-splits with its coercers; the
// entry drops ~30-40kB gz and Zod leaves it entirely (the C6a regression).
const ResearchArtifact = lazy(() => import("./artifacts/ResearchArtifact").then((m) => ({ default: m.ResearchArtifact })));
const PlanArtifact = lazy(() => import("./artifacts/PlanArtifact").then((m) => ({ default: m.PlanArtifact })));
const RevisionDiff = lazy(() => import("./RevisionDiff").then((m) => ({ default: m.RevisionDiff })));
const DecisionArtifactView = lazy(() => import("./DecisionCard").then((m) => ({ default: m.DecisionArtifactView })));
const CodeChangeArtifact = lazy(() => import("./artifacts/CodeChangeArtifact").then((m) => ({ default: m.CodeChangeArtifact })));
const ChangesetArtifact = lazy(() => import("./artifacts/ChangesetArtifact").then((m) => ({ default: m.ChangesetArtifact })));
const ReasoningCard = lazy(() => import("./artifacts/ReasoningCard").then((m) => ({ default: m.ReasoningCard })));
const SpecArtifact = lazy(() => import("./artifacts/SpecArtifact").then((m) => ({ default: m.SpecArtifact })));
// #190 — the end-of-feature DEBRIEF (comprehension surface). Lazy like the
// others so its coerceDebriefContent (Zod) stays out of the entry chunk.
const DebriefArtifact = lazy(() => import("./artifacts/DebriefArtifact").then((m) => ({ default: m.DebriefArtifact })));
// #190 A2 — the read-only EXPLAINER walk-through. Lazy like the others so its
// coerceExplainerContent (Zod) stays out of the entry chunk.
const ExplainerArtifact = lazy(() => import("./artifacts/ExplainerArtifact").then((m) => ({ default: m.ExplainerArtifact })));
// #180 — the decision-comment thread with carryover markers. LAZY so its Zod
// coercion (coerceDecisionContent) stays out of the entry chunk; only decision
// artifacts mount it (every other type keeps the plain CommentThread below).
const DecisionGeneralComments = lazy(() => import("./decision/DecisionGeneralComments").then((m) => ({ default: m.DecisionGeneralComments })));
// "Write to your pair" — the clarity chip. LAZY for the same reason as the
// renderers above: it imports the shared package's RUNTIME index (prose-lint),
// which would otherwise pull Zod back into this entry chunk. It renders null
// when the artifact's prose is clean, so most cards pay nothing for it.
const ClarityChip = lazy(() => import("./ClarityChip").then((m) => ({ default: m.ClarityChip })));
import { CommentThread } from "./CommentThread";
import { useChainComments } from "../hooks/useChainComments";
import { ArtifactIcon } from "./icons/ArtifactIcons";
import { FirstRunWalkthrough } from "./WalkthroughCards";
import { CausalChain } from "./CausalChain";
import { ErrorBoundary } from "./ErrorBoundary";
import { PreflightBreadcrumb } from "./PreflightBreadcrumb";
import { SecretWarningBanner } from "./SecretWarningBanner";
import { WAITING_TONE } from "../lib/waitingTone";
import { computeAttention } from "../lib/attention";
import { laneMarksFrom, laneMarkFor, type LaneMark } from "../lib/laneMarks";

const statusDots: Record<string, string> = {
  // B1 — draft is the one status that NEEDS the human, yet it was styled as the
  // quietest dot in the sidebar (dimmer than approved/rejected). Amber matches
  // the "Your turn" pill so a glance shows where your turn lives; `revised`
  // shares amber deliberately — both mean "awaiting your review".
  draft: "bg-accent-amber",
  reviewing: "bg-accent-blue-strong",
  approved: "bg-accent-green",
  // F8 (L4) — revised means BACK TO THE AGENT (its own glyph comment says
  // so, and computePending excludes it); wearing the your-turn amber made
  // the sidebar dot signal a false turn. #430 PR 1d — the agent's-turn
  // family is ONE blue (lib/waitingTone), not violet; the ↻ glyph and the
  // "Revision requested" label keep it from being colour-only.
  revised: WAITING_TONE.dot,
  rejected: "bg-accent-red",
  superseded: "bg-text-muted opacity-40",
  retracted: "bg-text-muted opacity-60",
  obsolete: "bg-text-muted opacity-40",
};

const statusColors: Record<string, string> = {
  // B1 — amber to match the sidebar dot + the Your-turn pill (draft = needs
  // you; it was the quietest badge while being the loudest call to action).
  draft: "bg-accent-amber-dim text-accent-amber",
  reviewing: "bg-accent-blue-dim text-accent-blue",
  approved: "bg-accent-green-dim text-accent-green",
  revised: WAITING_TONE.chip,
  rejected: "bg-accent-red-dim text-accent-red",
  superseded: "bg-surface-elevated text-text-muted",
  retracted: "bg-surface-elevated text-text-muted",
  obsolete: "bg-surface-elevated text-text-muted",
};

/**
 * Non-color status glyph. Paired with `statusDots` colors, this gives every
 * artifact TWO differentiators — shape + color — so status is legible
 * colorblind-friendly and without ambient highlighting.
 */
const statusGlyph: Record<string, string> = {
  draft: "●",      // solid dot — unreviewed
  reviewing: "⧗",  // hourglass — in-flight
  approved: "✓",   // check — done
  revised: "↻",    // cycle — back to the agent
  rejected: "✗",   // cross — dead
  superseded: "⇈", // double up — replaced by newer version
  retracted: "↩",  // return arrow — agent backed out
  obsolete: "⊘",   // circled slash — overcome by new information
};

const statusLabels: Record<string, string> = {
  draft: "Draft, awaiting review",
  reviewing: "Under review",
  approved: "Approved",
  revised: "Revision requested",
  rejected: "Rejected",
  superseded: "Superseded by newer version",
  retracted: "Retracted by agent",
  obsolete: "Overcome by new information",
};

/**
 * #430 PR 0 → PR 4 (docs/design/attention-hierarchy.md §5, §8) — the SIDEBAR dot
 * agrees with the attention model. An artifact that is a lane item wears its
 * lane mark (▲ decide, ● review, ○ read, ◌ waiting — lib/laneMarks, derived from
 * computeAttention, the bar's own selector); every other artifact keeps its
 * status dot, glyph and label. `dot` carries both the fill and the glyph colour.
 */
function sidebarStatus(a: Artifact, lanes: Record<string, LaneMark>): { dot: string; glyph: string; label: string } {
  const lane = lanes[a.id];
  if (lane) return lane;
  return { dot: `${statusDots[a.status] ?? ""} text-white`, glyph: statusGlyph[a.status] ?? "•", label: statusLabels[a.status] ?? a.status };
}

/** #193 E2 — the status label, type-aware. A DRAFT explainer is not "awaiting
 *  review" — it's a read-only walk-through the human should READ; the verdict
 *  framing ("Draft, awaiting review") mis-casts it. Say "New — for you to read"
 *  so the chip matches its acknowledge (Got it) footer. Every other type/status
 *  is unchanged. */
export function statusLabelFor(artifact: Artifact): string {
  if (artifact.type === "explainer" && artifact.status === "draft") return "New — for you to read";
  // #193 E2 — after "Got it" the explainer is approved under the hood, but the
  // verdict word "Approved" is exactly the framing this surface drops. Say
  // "Read" — the SAME word the footer's acknowledge chip uses — so the state
  // reads coherently in the header and the footer.
  if (artifact.type === "explainer" && artifact.status === "approved") return "Read";
  return statusLabels[artifact.status] ?? artifact.status;
}

const typeLabels: Record<string, string> = {
  research: "Research",
  spec: "Specs",
  plan: "Plans",
  decision: "Decisions",
  code_change: "Code",
  changeset: "Changesets",
  reasoning: "Reasoning",
  debrief: "Debriefs",
  explainer: "Explainers",
};

function RelatedArtifacts({ ids }: { ids: string[] }) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const related = ids.map((id) => artifacts.find((a) => a.id === id)).filter(Boolean) as Artifact[];

  if (related.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-2xs text-text-muted">Related:</span>
      {related.map((a) => (
        <button
          key={a.id}
          onClick={() => selectArtifact(a.id)}
          className="inline-flex items-center gap-1 px-2 py-0.5 bg-surface-elevated border border-border-subtle
                     rounded text-2xs text-text-secondary hover:border-accent-blue hover:text-accent-blue transition-colors"
        >
          <ArtifactIcon type={a.type} className="w-3 h-3" />
          {a.title}
        </button>
      ))}
    </div>
  );
}

function EditableTitle({ artifact }: { artifact: Artifact }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.title);
  const renameArtifact = useArtifactStore((s) => s.renameArtifact);

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== artifact.title) {
      renameArtifact(artifact.id, trimmed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
          if (e.key === "Escape") { setDraft(artifact.title); setEditing(false); }
        }}
        autoFocus
        className="text-sm font-semibold text-text-primary leading-[1.2] bg-surface-secondary border border-accent-blue rounded px-1.5 py-0.5
                   focus:outline-none focus:ring-1 focus:ring-accent-blue min-w-[200px]"
      />
    );
  }

  return (
    // Q4 (round-12 UX #4) — h2, not h3. The app's only h1 is "deepPairing" in
    // the shell header, so the artifact title (the top of the detail pane, and
    // the thing a screen-reader user jumps to) sat at h1→h3: a level skip on
    // the PRIMARY content path. The classes are untouched — the level is the
    // whole change, and the artifact's own section headings step to h3 below it.
    <h2
      className="text-sm font-semibold text-text-primary leading-[1.2] cursor-pointer hover:text-accent-blue transition-colors"
      onClick={() => { setDraft(artifact.title); setEditing(true); }}
      title="Click to rename"
    >
      {artifact.title}
    </h2>
  );
}

// L1 (#194) — every artifact type this page version knows how to render. A
// type NOT in this set falls through to UnsupportedArtifact instead of a blank
// body (a stale cached tab meeting a newer daemon's future type).
const KNOWN_ARTIFACT_TYPES = new Set<string>([
  "research", "spec", "plan", "reasoning", "code_change",
  "changeset", "decision", "debrief", "explainer",
]);

/**
 * L1 (#194) — the graceful fallback for an unrecognized artifact type. Renders
 * a quiet "reload to update" notice plus whatever human-readable text we can
 * coerce off the raw content (summary / overview / title / context), so the
 * surface is never empty even when this tab is older than the daemon.
 */
function UnsupportedArtifact({ artifact }: { artifact: Artifact }) {
  const content = (artifact.content ?? {}) as Record<string, unknown>;
  const rawText = ["summary", "overview", "context", "detail", "description"]
    .map((k) => content[k])
    .find((v): v is string => typeof v === "string" && v.trim().length > 0);
  return (
    <div
      className="mx-3 my-3 p-4 rounded-lg border border-border-default bg-surface-elevated"
      role="status"
      data-testid="unsupported-artifact"
    >
      <div className="text-sm font-medium text-text-secondary">
        This artifact type isn't supported by this page version — reload to update.
      </div>
      <div className="mt-1 text-2xs text-text-muted">
        Type: <span className="font-mono">{String(artifact.type)}</span>
      </div>
      {(artifact.title || rawText) && (
        <div className="mt-2 text-xs text-text-secondary">
          {artifact.title && <div className="font-semibold text-text-primary">{artifact.title}</div>}
          {rawText && <p className="mt-1 whitespace-pre-wrap">{rawText}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * L-9 (#213) — the Suspense fallback while a lazy artifact renderer chunk loads
 * (~1s on a cold cache). The old fallback was a single 24px pulse bar, so
 * selecting an artifact flashed a near-empty grey body before content landed.
 * This shimmer mimics an artifact's real shape — a title bar, a prose block, a
 * body panel, a short trailing block — so the fill-in reads as content ARRIVING,
 * not a layout jump. Deliberately generic (one skeleton for every type): a
 * per-type skeleton would out-detail its value while the chunk is in flight.
 * Distinct from UnsupportedArtifact (E3): that renders a text NOTICE outside the
 * Suspense boundary for an unknown type; this is a decorative loading state.
 */
function ArtifactSkeleton() {
  return (
    <div
      className="space-y-4 animate-pulse"
      role="status"
      aria-label="Loading artifact view"
      data-testid="artifact-skeleton"
    >
      {/* Title bar */}
      <div className="h-6 w-2/3 rounded bg-surface-elevated" />
      {/* Prose block */}
      <div className="space-y-2">
        <div className="h-3 w-full rounded bg-surface-elevated" />
        <div className="h-3 w-11/12 rounded bg-surface-elevated" />
        <div className="h-3 w-4/5 rounded bg-surface-elevated" />
      </div>
      {/* Body panel (evidence / diagram / option grid stand-in) */}
      <div className="h-24 rounded bg-surface-elevated" />
      {/* Trailing block */}
      <div className="space-y-2">
        <div className="h-3 w-5/6 rounded bg-surface-elevated" />
        <div className="h-3 w-2/3 rounded bg-surface-elevated" />
      </div>
    </div>
  );
}

// Exported for tests (#158 — the secret-warning banner renders here).
export function ArtifactDetail({ artifact }: { artifact: Artifact }) {
  const headerGlyph = laneMarkFor(artifact)?.glyph ?? statusGlyph[artifact.status];
  const contentWidth = usePreferencesStore((s) => s.contentWidth);
  // #204 (UX L2) — the artifact-level comment thread's WRITE AXIS, derived through
  // the shared reviewLifecycle helper. A retracted/terminal ("closed") or replayed
  // ("frozen") artifact is read-only: posted comments stay readable, the composer
  // is withheld. Draft ("review") + approved ("follow_up") keep the composer.
  const replayActive = useReplayStore((s) => s.active);
  const commentsReadOnly = (() => {
    const lc = reviewLifecycle(artifact.status, replayActive);
    return lc === "closed" || lc === "frozen";
  })();
  // Bug2 — aggregate comments across the version chain so v1's general
  // comments render on v2 after a supersede auto-advance.
  const comments = useChainComments(artifact.id);
  const generalComments = comments.filter(
    (c) =>
      c.target.lineNumber == null &&
      c.target.findingIndex == null &&
      c.target.stepIndex == null &&
      c.target.lineStart == null &&
      // #164 — question-targeted comments now render INLINE in their
      // OpenQuestionSection; without this arm they showed twice (section +
      // this bottom thread). `== null` (not falsy!) — questionIndex 0 is a
      // valid target on the first question.
      c.target.questionIndex == null,
  );

  return (
    <m.div
      key={artifact.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
      // X10 — scoping attribute used by scrollToAnchor() to disambiguate
      // anchors when two artifacts are on the page during transitions.
      data-artifact-id={artifact.id}
      // #403 — the scrolling pane a diagram popover must stay visible inside
      // (with the sticky chrome marked below): DiagramRegionLayer measures it.
      data-dp-pane=""
      className={`flex-1 overflow-y-auto p-4 space-y-4 scroll-shadow w-full ${
        contentWidth === "constrained" ? "max-w-4xl mx-auto" : ""
      }`}
    >
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <ArtifactIcon type={artifact.type} className="text-text-secondary" />
          <EditableTitle artifact={artifact} />
          <span className={`px-1.5 py-0.5 text-2xs font-medium rounded ${statusColors[artifact.status]}`}>
            {/* U6 — friendly label + glyph, matching the sidebar; not the raw
                enum ("superseded"/"reviewing"). */}
            {/* #430 PR 4 — a lane item shows its lane glyph here too, so the
                header never disagrees with the sidebar row. */}
            {headerGlyph ? `${headerGlyph} ` : ""}
            {statusLabelFor(artifact)}
          </span>
          {artifact.version > 1 && (
            <span className="text-2xs text-text-muted">v{artifact.version}</span>
          )}
          {/* House prose check. Computed client-side from the same shared
              linter the server uses for its STYLE warnings; null when clean. */}
          <Suspense fallback={null}>
            <ClarityChip artifact={artifact} />
          </Suspense>
        </div>
        {artifact.agentReasoning && (
          <p className="text-xs text-text-muted italic">{artifact.agentReasoning}</p>
        )}
      </div>

      {/* #158 — secret-warning banner, directly under the header and OUTSIDE
          the lazy Suspense boundary so it's visible on first paint, before
          the type-specific renderer (which contains the flagged text) even
          loads. Renders null unless the server-side scan matched. */}
      <SecretWarningBanner artifact={artifact} />

      {/* L1 (#194) — a stale cached tab can receive a FUTURE artifact type a
          newer daemon pushes; the type-specific renderer chain below has no
          branch for it and would fall through to a BLANK body. Render a quiet
          "reload to update" notice + whatever raw text we can coerce. Kept
          OUTSIDE the lazy Suspense boundary (like the secret banner) so it
          paints immediately and never waits on the lazy renderers it replaces. */}
      {!KNOWN_ARTIFACT_TYPES.has(artifact.type) && <UnsupportedArtifact artifact={artifact} />}

      {/* D6 — lazy chunk boundary. MUST wrap every lazy component below
          (RevisionDiff included — review lesson: a suspension outside the
          boundary suspends the whole tree with no fallback). */}
      <Suspense fallback={<ArtifactSkeleton />}>
      {/* Revision diff — when this artifact supersedes a prior version, show
          what changed (anchored to the agent's revise reason) so the human
          sees their feedback land instead of eyeballing v2 against memory. */}
      <RevisionDiff artifact={artifact} />

      {/* Z3 — preflight breadcrumb hoisted ABOVE the type-specific renderer
          so the moat frames the proposal instead of footnoting it. PMF
          council Y review: the single line that distinguishes deepPairing
          from Cursor 3 was the LAST thing the user saw, after they'd
          already decided. Now it's the first thing under the header. */}
      <PreflightBreadcrumb artifactId={artifact.id} />

      {/* Causal chain — shows artifact relationships */}
      <CausalChain />

      {/* Related artifacts */}
      {artifact.relatedArtifactIds && artifact.relatedArtifactIds.length > 0 && (
        <RelatedArtifacts ids={artifact.relatedArtifactIds} />
      )}

      {/* Type-specific renderer */}
      {artifact.type === "research" && <ResearchArtifact artifact={artifact} />}
      {artifact.type === "spec" && <SpecArtifact artifact={artifact} />}
      {artifact.type === "plan" && <PlanArtifact artifact={artifact} />}
      {artifact.type === "reasoning" && <ReasoningCard artifact={artifact} />}
      {artifact.type === "code_change" && (
        <CodeChangeArtifact artifact={artifact} />
      )}
      {artifact.type === "changeset" && <ChangesetArtifact artifact={artifact} />}
      {artifact.type === "decision" && <DecisionArtifactView artifact={artifact} />}
      {artifact.type === "debrief" && <DebriefArtifact artifact={artifact} />}
      {artifact.type === "explainer" && <ExplainerArtifact artifact={artifact} />}
      </Suspense>

      {/* General comments.
          #193 E2 (usability M2) — the DEBRIEF and EXPLAINER carry their OWN
          "Ask me anything" composer (the conversational surface for the whole
          artifact). Rendering this second artifact-level thread underneath
          stacked a redundant composer — two boxes posting the same
          artifact-level comment. Fold it away for those two types; the
          renderer's ask-anything thread is the single composer. Every other type
          keeps this thread byte-for-byte unchanged. */}
      {artifact.type !== "debrief" && artifact.type !== "explainer" && (
      <div className="pt-3 border-t border-border-default">
        {/* Q4 — artifact section headings step to h3 under the h2 title. */}
        <h3 className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-2">
          Comments
        </h3>
        {/* #180 — for a DECISION artifact, the flat thread's grain comments get
            the carryover marker (CARRIED / STALE / ORPHAN) instead of the bare
            "from vN" chip. Lazy + decision-only so non-decision types keep the
            plain thread unchanged and the entry chunk stays Zod-free. */}
        {artifact.type === "decision" ? (
          <Suspense fallback={<div className="h-16 rounded bg-surface-elevated animate-pulse" aria-label="Loading comments" role="status" />}>
            <DecisionGeneralComments artifact={artifact} comments={generalComments} readOnly={commentsReadOnly} />
          </Suspense>
        ) : (
          /* The question lane was structurally dead: a dry-run over real data
             found ZERO comments carrying `intent`, so collectUnansweredQuestions
             (and every consumer of it, incl. check_feedback's owed-questions
             queue) always returned empty. The plumbing was fine end to end —
             the composers people actually use simply had no way to SAY
             "question". This is the main per-artifact thread and it had no Ask
             button; opting it in is the whole fix here. */
          <CommentThread
            artifactId={artifact.id}
            comments={generalComments}
            readOnly={commentsReadOnly}
            secondarySubmitLabel="Ask"
            secondarySubmitTitle="Post as a question — the agent owes you an answer before it moves on"
          />
        )}
      </div>
      )}
    </m.div>
  );
}

type SidebarGrouping = "type" | "timeline" | "flow";

// Persist the picked grouping across reloads (Flow is the fresh-tab default).
const GROUPING_KEY = "dp-sidebar-grouping";
function readGrouping(): SidebarGrouping {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return "flow";
  try {
    const v = localStorage.getItem(GROUPING_KEY);
    return v === "type" || v === "timeline" || v === "flow" ? v : "flow";
  } catch { return "flow"; }
}
function writeGrouping(g: SidebarGrouping): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try { localStorage.setItem(GROUPING_KEY, g); } catch { /* best-effort */ }
}

/**
 * Build causal-chain groups from relatedArtifactIds + parentId.
 *
 * Bug4 — the old version keyed groups by a 28-char TITLE prefix (two roots
 * sharing a prefix silently OVERWROTE each other, dropping a whole flow),
 * ordered groups by the chain SINK, ordered items newest→oldest, and ignored
 * parentId — so a superseded v1 (filtered out of `visible`) dangled every ref
 * that pointed at it and v2 fell out as an orphan root at the bottom.
 *
 * Now: key each group by its ROOT ARTIFACT ID (kills the silent overwrite;
 * titles stay display-only, derived from the first item by the consumer);
 * treat parentId as a graph edge and resolve related ids that point at a
 * superseded artifact to its live successor (via resolveToLiveId over the FULL
 * artifact list) so v1→v2 stay one flow; sort items within a chain by
 * createdAt ascending; and order groups by each group's min(createdAt) so
 * flows read start-first, orphans interleaved by their own createdAt (no
 * forced-last "Other").
 *
 * `allArtifacts` includes superseded versions (filtered out of `visible`) so
 * the resolve can cross the filtered node; defaults to `visible` for callers
 * that don't filter.
 */
export function buildFlowGroups(
  visible: Artifact[],
  allArtifacts: Artifact[] = visible,
): Map<string, Artifact[]> {
  const visibleById = new Map(visible.map((a) => [a.id, a] as const));
  // Resolve an id (possibly pointing at a superseded, filtered-out version) to
  // the visible artifact that stands in for it.
  const resolveVisibleId = (id: string): string | undefined => {
    const live = resolveToLiveId(allArtifacts, id);
    return visibleById.has(live) ? live : undefined;
  };

  // Undirected adjacency over the visible set: relatedArtifactIds (resolved)
  // and parentId (resolved) are both graph edges.
  const adj = new Map<string, Set<string>>();
  for (const a of visible) adj.set(a.id, new Set());
  const link = (x: string, y: string) => {
    if (x === y) return;
    adj.get(x)?.add(y);
    adj.get(y)?.add(x);
  };
  for (const a of visible) {
    for (const rid of a.relatedArtifactIds ?? []) {
      const v = resolveVisibleId(rid);
      if (v) link(a.id, v);
    }
    if (a.parentId) {
      const v = resolveVisibleId(a.parentId);
      if (v) link(a.id, v);
    }
  }

  // Connected components via BFS — an orphan is just a singleton component.
  const seen = new Set<string>();
  const components: Artifact[][] = [];
  for (const a of visible) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const stack = [a.id];
    const comp: Artifact[] = [];
    while (stack.length) {
      const id = stack.pop()!;
      const art = visibleById.get(id);
      if (art) comp.push(art);
      for (const n of adj.get(id) ?? []) {
        if (!seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    // Oldest → newest within the flow.
    comp.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    components.push(comp);
  }

  // Order flows by their START time (min createdAt); key by the root (oldest)
  // id so two roots that share a title prefix stay distinct groups.
  components.sort((x, y) => x[0]!.createdAt.localeCompare(y[0]!.createdAt));
  const groups = new Map<string, Artifact[]>();
  for (const comp of components) groups.set(comp[0]!.id, comp);
  return groups;
}

/** Flow-mode section header: the root (first, oldest) item's title, truncated.
 *  Keeps the title DISPLAY-only now that groups are keyed by root id. */
function flowGroupLabel(items: Artifact[], fallback: string): string {
  const title = items[0]?.title;
  if (!title) return fallback;
  return title.length > 30 ? title.slice(0, 28) + "..." : title;
}

/** How many most-recent artifacts the sidebar shows before collapsing the
 *  rest behind a "Show N older" toggle (keeps a deep session scannable). */
const SIDEBAR_RECENT_LIMIT = 10;

/** How long a just-arrived artifact card stays highlighted (glow / static ring)
 *  before it fades back to normal. Matches the CSS `dp-arrival-glow` duration so
 *  the animation completes exactly as the id drops out of the highlight set. */
const ARRIVAL_HIGHLIGHT_MS = 4500;

/** Quiet window after the store's population stops changing before we consider
 *  the panel "hydrated" and start treating further additions as live arrivals.
 *  Absorbs the initial batch AND the aggregator tab's async cross-session
 *  backfill (MultiAgentSync fetches other sessions' HISTORY a few ticks after
 *  the panel already mounted). Every localhost backfill settles well inside
 *  this; a genuine arrival within it is only ever *missed* (no false glow). */
const HYDRATION_SETTLE_MS = 750;

/**
 * New-item locator — tracks which artifacts arrived LIVE (after the panel had
 * hydrated) so the sidebar can gently mark them. It never moves scroll; it only
 * decides *which ids are new*.
 *
 * Why this can't fire on load — the two-guard model:
 *  1. Nothing highlights until `hydratedRef` is true. Hydration is a QUIESCENCE
 *     signal, not "first effect run": every population change re-arms a
 *     HYDRATION_SETTLE_MS debounce, and only a quiet gap flips hydrated true.
 *     This is what defeats the aggregator repro — a tab that mounts with an
 *     EMPTY store and then gets other sessions' history back-filled via async
 *     `addArtifact` loops (MultiAgentSync) keeps re-arming the debounce, so
 *     that whole historical batch is absorbed as already-seen, never glowed. It
 *     also re-hydrates cleanly on a reconnect (the store resets to empty then
 *     repopulates) instead of glowing the entire reloaded session.
 *  2. Once hydrated, `seenRef` holds the known id set; only a delta (an id
 *     present now that wasn't before) counts as an arrival. Nothing is
 *     persisted, so a page reload re-hydrates the full set as already-seen.
 *
 * `enabled` is false during replay (the panel hides post-cursor artifacts, so
 * "new" is meaningless there): while disabled we silently absorb the current
 * set as seen and clear any lingering highlight, so toggling replay off doesn't
 * spuriously glow the re-revealed items.
 */
function useArrivalHighlights(
  artifacts: Artifact[],
  enabled: boolean,
  /** #430 PR 3 — with the Next-up bar on, an arrival that BECOMES `next` is
   *  announced by the bar (one announcer per change, §7); this region stays
   *  quiet about it and announces only the other arrivals. */
  barAnnouncesNext = false,
): { highlightedIds: string[]; announcement: string } {
  // Ordered by arrival (append) so the pip can point at the NEWEST off-screen
  // one. A plain string[] keeps to the no-Set/Map-in-state convention.
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const seenRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // false until the population quiesces (see HYDRATION_SETTLE_MS). A ref, not
  // state: flipping it must NOT itself re-render — the next real arrival re-runs
  // the effect and reads the current value.
  const hydratedRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable key so the effect only re-runs when the id SET changes, not on every
  // parent render (`artifacts` is a fresh array identity each time).
  const idKey = artifacts.map((a) => a.id).join("|");

  useEffect(() => {
    const current = new Set(artifacts.map((a) => a.id));

    // Empty store — initial mount OR a reset/reconnect re-hydration. Re-enter
    // the hydrating window: absorb as seen, glow nothing, and DON'T arm settle
    // (an empty tab shouldn't "hydrate" then glow its first back-filled card).
    if (current.size === 0) {
      seenRef.current = current;
      hydratedRef.current = false;
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      return;
    }

    if (!enabled) {
      // Replay (or any suppressed context): absorb silently, drop any glow +
      // pending timers so nothing lingers when tracking resumes.
      seenRef.current = current;
      for (const t of Object.values(timersRef.current)) clearTimeout(t);
      timersRef.current = {};
      setHighlightedIds((prev) => (prev.length ? [] : prev));
      return;
    }

    // Still hydrating: absorb this population as already-seen and (re)arm the
    // quiesce debounce. No glow, no announcement — this is the load/backfill
    // guard that makes the aggregator repro produce ZERO glow.
    if (!hydratedRef.current) {
      seenRef.current = current;
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        hydratedRef.current = true;
        settleTimerRef.current = null;
      }, HYDRATION_SETTLE_MS);
      return;
    }

    const prevSeen = seenRef.current;
    // #458 review — a sibling session's backfilled HISTORY is never an arrival.
    const arrived = artifacts.filter((a) => !prevSeen.has(a.id) && !isBackfilled(a.id));
    seenRef.current = current;
    if (arrived.length === 0) return;

    const arrivedIds = arrived.map((a) => a.id);
    setHighlightedIds((prev) => {
      const merged = prev.slice();
      for (const id of arrivedIds) if (!merged.includes(id)) merged.push(id);
      return merged;
    });

    // One announcement per arrival EVENT (a burst collapses to a single summary
    // line), not a per-id stream — keeps the aria-live region polite.
    const nextId = barAnnouncesNext ? computeAttention({ artifacts }).next?.id : undefined;
    const toAnnounce = nextId ? arrived.filter((a) => a.id !== nextId) : arrived;
    if (toAnnounce.length > 0) {
      setAnnouncement(
        toAnnounce.length === 1
          ? `New artifact: ${toAnnounce[0]!.title}`
          : `${toAnnounce.length} new artifacts`,
      );
    }

    // Each id fades on its own timer (a later arrival doesn't cut an earlier
    // card's highlight short).
    for (const id of arrivedIds) {
      if (timersRef.current[id]) clearTimeout(timersRef.current[id]);
      timersRef.current[id] = setTimeout(() => {
        setHighlightedIds((prev) => prev.filter((x) => x !== id));
        delete timersRef.current[id];
      }, ARRIVAL_HIGHLIGHT_MS);
    }
    // idKey drives re-runs; `artifacts` is read via closure. `enabled` included
    // so a replay toggle re-evaluates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey, enabled, barAnnouncesNext]);

  // Clear any outstanding fade + settle timers on unmount.
  useEffect(
    () => () => {
      for (const t of Object.values(timersRef.current)) clearTimeout(t);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  return { highlightedIds, announcement };
}

/** Sidebar artifact list with grouping modes */
function ArtifactSidebar({
  typeGroups,
  artifacts,
  selectedArtifactId,
  unreadIds,
  highlightedIds,
  collapsed,
  headerExtra,
  width,
  onToggle,
}: {
  typeGroups: Map<string, Artifact[]>;
  artifacts: Artifact[];
  selectedArtifactId: string | null;
  unreadIds: string[];
  /** Ids of artifacts that arrived LIVE and should be gently marked + located.
   *  Empty during initial load and replay (see useArrivalHighlights). */
  highlightedIds: string[];
  collapsed: boolean;
  /** #430 PR 5 — the Agents filter menu (bar ON, expanded sidebar). */
  headerExtra?: ReactNode;
  width: number;
  onToggle: () => void;
}) {
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  // #430 PR 4 — each row's lane glyph comes from the bar's own selector.
  const laneMarks = useMemo(() => laneMarksFrom(computeAttention({ artifacts })), [artifacts]);
  // New-item locator plumbing. The scroll container + per-item nodes let the
  // off-screen pip figure out whether a just-arrived card is above/below the
  // viewport WITHOUT ever moving scroll on arrival.
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // prefers-reduced-motion: swap the animated glow for a static ring (the
  // marker must not depend on motion). Reactive so a live OS-setting change is
  // honoured on the next arrival.
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // The off-screen pip: which direction to point + how many new cards are out
  // of view + the newest such card to scroll to on click. null = nothing to
  // locate (all new items already in view, or none).
  const [pip, setPip] = useState<{ dir: "up" | "down"; count: number; targetId: string } | null>(null);

  // #430 PR 5 (PR 4 review) — the lane label on KEYBOARD focus. The glyph's
  // tooltip was hover-only (`title`). The row button is already the one tab
  // stop per row and its accessible name already carries the label, so rather
  // than make the dot a second tab stop, a keyboard focus on the row shows the
  // same label as a visible tooltip beside the rail, centred on the row.
  // Pointer focus (a click) never shows it. aria-hidden:
  // a screen reader already hears the label in the row's name.
  const navRef = useRef<HTMLElement>(null);
  const keyboardModality = useRef(false);
  const [focusTip, setFocusTip] = useState<{ label: string; top: number; left: number } | null>(null);
  useEffect(() => {
    const onKey = () => { keyboardModality.current = true; };
    const onPointer = () => { keyboardModality.current = false; };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("mousedown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("mousedown", onPointer, true);
    };
  }, []);
  const showFocusTip = (row: HTMLElement, label: string) => {
    const nav = navRef.current;
    if (!keyboardModality.current || !nav) return;
    const n = nav.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    // #455 review — beside the rail, centred on the row (translateY(-50%)),
    // in both modes: below the row it covered the NEXT row's title.
    setFocusTip({ label, top: r.top - n.top + r.height / 2, left: n.width + 4 });
  };

  // Recompute the pip whenever the highlight set changes or the user scrolls /
  // resizes. Reads live geometry via getBoundingClientRect — never writes it,
  // so arrival never moves scroll.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || highlightedIds.length === 0) {
      setPip(null);
      return;
    }
    const compute = () => {
      const cRect = container.getBoundingClientRect();
      // Degenerate/unlaid-out viewport (zero height) → nothing to locate.
      if (cRect.bottom <= cRect.top) {
        setPip(null);
        return;
      }
      let count = 0;
      let newest: { dir: "up" | "down"; targetId: string } | null = null;
      // Arrival order → the LAST off-screen id is the newest one; the pip
      // points there.
      for (const id of highlightedIds) {
        const el = itemRefs.current[id];
        if (!el) continue;
        const iRect = el.getBoundingClientRect();
        let dir: "up" | "down" | null = null;
        if (iRect.bottom <= cRect.top) dir = "up";
        else if (iRect.top >= cRect.bottom) dir = "down";
        if (dir) {
          count++;
          newest = { dir, targetId: id };
        }
      }
      setPip(newest ? { ...newest, count } : null);
    };
    compute();
    container.addEventListener("scroll", compute, { passive: true });
    window.addEventListener("resize", compute);
    return () => {
      container.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
  }, [highlightedIds]);
  // Bug4 — the FULL artifact list (incl. superseded, filtered out of the
  // visible `artifacts` prop) so flow grouping can resolve a ref pointing at a
  // superseded v1 to its live v2 successor and keep the chain together.
  const allArtifacts = useArtifactStore((s) => s.artifacts);
  // Flow (causal chain) is the fresh-tab default — once a project is deep,
  // grouping by type scatters a finding → plan → change thread across buckets.
  // The user's pick persists across reloads.
  const [grouping, setGroupingState] = useState<SidebarGrouping>(() => readGrouping());
  const setGrouping = (g: SidebarGrouping) => { writeGrouping(g); setGroupingState(g); };

  // Build groups based on selected mode
  const groups = useMemo((): Map<string, Artifact[]> => {
    if (grouping === "type") return typeGroups;
    if (grouping === "timeline") {
      const sorted = [...artifacts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return new Map([["All Artifacts", sorted]]);
    }
    return buildFlowGroups(artifacts, allArtifacts);
  }, [grouping, typeGroups, artifacts, allArtifacts]);

  // Keep the sidebar from becoming a wall of scroll on a deep session: show
  // only the most-recent N artifacts by default, collapse the rest behind a
  // "Show N older" toggle. The currently-selected artifact is always kept
  // visible even if it's old, so the list never hides where you are.
  // #430 PR 0 (docs/design/attention-hierarchy.md §4.3) — and neither does it
  // hide what is WAITING ON YOU: every draft awaiting review is kept too. The
  // cutoff hid the only high-stakes decision behind "Show 6 older"; it now
  // applies to non-pending items only.
  const [showAllOlder, setShowAllOlder] = useState(false);
  const recentIds = useMemo(() => {
    const ids = new Set(
      [...artifacts]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, SIDEBAR_RECENT_LIMIT)
        .map((a) => a.id),
    );
    if (selectedArtifactId) ids.add(selectedArtifactId);
    for (const a of artifacts) if (isDraftAwaitingReview(a)) ids.add(a.id);
    return ids;
  }, [artifacts, selectedArtifactId]);
  const olderCount = artifacts.filter((a) => !recentIds.has(a.id)).length;
  const visibleGroups = useMemo(() => {
    if (showAllOlder || olderCount === 0) return groups;
    const filtered = new Map<string, Artifact[]>();
    for (const [label, items] of groups) {
      const kept = items.filter((a) => recentIds.has(a.id));
      if (kept.length) filtered.set(label, kept);
    }
    return filtered;
  }, [groups, showAllOlder, olderCount, recentIds]);

  return (
    // Q4 (round-12 UX #4) — the artifact rail IS navigation: a list of links to
    // the things under review. As a bare <div> it was outside every landmark,
    // so the whole left column was unreachable by landmark jump and the
    // "skip to the list of artifacts" move didn't exist. <nav> + a name;
    // the classes and the layout are untouched.
    <nav
      ref={navRef}
      aria-label="Artifacts"
      className={`relative shrink-0 border-r border-border-default bg-surface-secondary transition-all duration-[180ms] ease-out ${
        collapsed ? "w-12" : ""
      }`}
      style={collapsed ? undefined : { width }}
    >
      {/* Inner scroll container — the new-item pip is positioned against the
          OUTER (relative) box so it stays pinned to the visible edge instead of
          scrolling away with the list. */}
      <div ref={scrollRef} data-testid="sidebar-scroll" className="h-full overflow-y-auto" onScroll={() => setFocusTip(null)}>
      {/* Collapse toggle + grouping selector */}
      <div className="flex items-center justify-between">
        <button
          onClick={onToggle}
          className="flex items-center justify-center py-1.5 px-2 text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            {collapsed ? (
              <path d="M4 2l4 4-4 4" />
            ) : (
              <path d="M8 2L4 6l4 4" />
            )}
          </svg>
        </button>

        {/* Grouping mode selector */}
        {!collapsed && (
          <div className="flex items-center gap-0.5 pr-2">
            {(["type", "flow", "timeline"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setGrouping(mode)}
                className={`px-1.5 py-0.5 rounded text-[9px] transition-colors ${
                  grouping === mode
                    ? "bg-surface-hover text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
                title={mode === "type" ? "Group by type" : mode === "flow" ? "Group by causal chain" : "Chronological timeline"}
              >
                {mode === "type" ? "Type" : mode === "flow" ? "Flow" : "Time"}
              </button>
            ))}
          </div>
        )}
      </div>

      {!collapsed && headerExtra}

      {/* "Show older" sits at the TOP so the recent items below it stay the
          focus — you scan down to the latest, not past a wall of old ones. */}
      {!collapsed && olderCount > 0 && (
        <button
          onClick={() => setShowAllOlder((v) => !v)}
          className="w-full text-left px-3 py-1.5 text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors select-none border-b border-border-subtle"
        >
          {showAllOlder ? "▴ Show fewer" : `▾ Show ${olderCount} older`}
        </button>
      )}

      {/* Grouped artifact list */}
      {Array.from(visibleGroups.entries()).map(([label, items]) => (
        <div key={label}>
          {/* Section header.
              #189 — in Flow mode a singleton group's header is just the lone
              artifact's own title in ALL-CAPS, one line above the row that
              already shows it — pure noise that made a fresh session read as
              framework chrome. Render the header only for a real GROUP (≥2
              items). Type/Timeline headers name the bucket (a type or a date),
              not the artifact, so they stay even for a single item. */}
          {!collapsed && (grouping !== "flow" || items.length >= 2) && (
            // Q4 (round-12 UX #4) — a real h2 inside the artifacts nav. It was
            // a styled div, so a screen reader could see the artifact list but
            // not the buckets it is grouped into. Classes unchanged.
            <h2 data-testid="sidebar-group-header" className="flex items-center gap-1.5 px-3 py-1 text-2xs font-semibold text-text-muted uppercase tracking-wide">
              {grouping === "type" && <ArtifactIcon type={label} className="w-3 h-3" />}
              {/* Bug4 — flow groups are keyed by root id; the header shows the
                  root artifact's (display-only) title, not the raw id. */}
              {grouping === "type"
                ? (typeLabels[label] ?? label)
                : grouping === "flow"
                  ? flowGroupLabel(items, label)
                  : label}
              <span className="opacity-50">{items.length}</span>
            </h2>
          )}

          {/* Items */}
          {items.map((a) => {
            const isSelected = a.id === selectedArtifactId;
            const isUnread = unreadIds.includes(a.id);
            // Just-arrived (live) card → gentle marker. Animated glow by
            // default; a static ring under prefers-reduced-motion. Both are
            // decorative (the aria-live region carries the real announcement)
            // and both clear when the id leaves highlightedIds after the
            // timeout, so the ring is NOT motion-dependent.
            const isNew = highlightedIds.includes(a.id);
            const arrivalClass = isNew ? (reducedMotion ? "dp-arrival-ring" : "dp-arrival-glow") : "";
            // L-8 (#213) — the collapsed icon-only rail's SCENT. E3 (#194) put
            // "Type: title — status" on the inner non-interactive <div>, leaving
            // the interactive <button> with only the bare `a.title`; a hover or a
            // probe reading the button (the element under the cursor / the one
            // tests target) got the thin scent, and aria-label on a bare <div> is
            // not reliably exposed. Compute the rich label once and hang it on the
            // BUTTON itself (title + aria-label) when collapsed — the icon column
            // is unreadable without it. Expanded rows show the title inline, so
            // they keep the plain `a.title` tooltip.
            const sb = sidebarStatus(a, laneMarks);
            const collapsedLabel = `${typeLabels[a.type] ?? a.type}: ${a.title} — ${sb.label}`;

            return (
              <button
                key={a.id}
                ref={(el) => { itemRefs.current[a.id] = el; }}
                data-artifact-item={a.id}
                onClick={() => selectArtifact(a.id)}
                className={`w-full flex items-center gap-2 transition-all duration-[180ms] ease-out ${
                  collapsed ? "justify-center px-1 py-1.5" : "px-3 py-1.5 text-left"
                } ${
                  isSelected
                    ? "bg-surface-hover border-l-2 border-l-accent-blue"
                    : "border-l-2 border-l-transparent hover:bg-surface-hover/50"
                } ${arrivalClass}`}
                title={collapsed ? collapsedLabel : a.title}
                aria-label={collapsed ? collapsedLabel : undefined}
                onFocus={(e) => showFocusTip(e.currentTarget, sb.label)}
                onBlur={() => setFocusTip(null)}
              >
                {collapsed ? (
                  <div className="relative">
                    <ArtifactIcon type={a.type} className={`w-4 h-4 ${isSelected ? "text-accent-blue" : "text-text-muted"}`} />
                    {/* Q4 (round-12 UX #5) — the unread dot was pure colour: no
                        name, no tooltip, invisible to a screen reader and
                        meaningless to anyone who can't pick blue out of the
                        rail. Title for the pointer, sr-only text for AT. */}
                    {isUnread && (
                      <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent-blue" title="Unread">
                        <span className="sr-only">Unread</span>
                      </span>
                    )}
                    <span
                      aria-label={sb.label}
                      className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full flex items-center justify-center text-[8px] leading-none ${sb.dot}`}
                    >
                      {sb.glyph}
                    </span>
                  </div>
                ) : (
                  <>
                    <ArtifactIcon
                      type={a.type}
                      className={`w-3.5 h-3.5 shrink-0 ${isSelected ? "text-accent-blue" : "text-text-muted"}`}
                    />
                    <span className={`text-2xs truncate flex-1 ${
                      isSelected ? "text-text-primary font-medium" : "text-text-secondary"
                    } ${a.status === "retracted" ? "line-through opacity-60" : ""}`}>
                      {a.title}
                    </span>
                    {/* #158 — compact secret-scan marker so a flagged artifact
                        is visible from the list, not only once opened. */}
                    {a.secretWarnings && a.secretWarnings.length > 0 && (
                      <span
                        aria-label="Possible secret detected"
                        title="Possible secret detected — review before approving"
                        className="shrink-0 text-accent-amber text-[10px] leading-none"
                      >
                        ⚠
                      </span>
                    )}
                    <span
                      aria-label={sb.label}
                      title={sb.label}
                      className={`shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] leading-none ${sb.dot}`}
                    >
                      {sb.glyph}
                    </span>
                    {/* Q4 — same unread dot, expanded-rail variant. */}
                    {isUnread && (
                      <span className="w-1.5 h-1.5 rounded-full bg-accent-blue shrink-0" title="Unread">
                        <span className="sr-only">Unread</span>
                      </span>
                    )}
                  </>
                )}
              </button>
            );
          })}
        </div>
      ))}
      </div>

      {/* Off-screen new-item pip — appears ONLY when a just-arrived card is
          outside the current scroll viewport, pointing the way to it. Clicking
          scrolls the newest such card into view; this scroll is USER-initiated
          (the arrival itself never moves scroll). A real <button> with a
          directional label, keyboard-operable and focus-visible. */}
      {!collapsed && pip && (
        <button
          type="button"
          onClick={() => {
            itemRefs.current[pip.targetId]?.scrollIntoView?.({
              block: "center",
              behavior: reducedMotion ? "auto" : "smooth",
            });
          }}
          aria-label={
            pip.count > 1
              ? `Jump to ${pip.count} new artifacts ${pip.dir === "up" ? "above" : "below"}`
              : `Jump to new artifact ${pip.dir === "up" ? "above" : "below"}`
          }
          className={`absolute left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-2 py-0.5 rounded-full
                      bg-accent-blue-strong text-white text-2xs font-medium shadow-md
                      hover:bg-accent-blue-strong-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue
                      transition-colors ${pip.dir === "up" ? "top-2" : "bottom-2"}`}
        >
          <span aria-hidden="true">{pip.dir === "up" ? "↑" : "↓"}</span>
          <span>{pip.count > 1 ? `${pip.count} new` : "new"}</span>
        </button>
      )}
      {focusTip && (
        <div
          aria-hidden="true"
          data-testid="lane-focus-tooltip"
          className="pointer-events-none absolute z-30 px-1.5 py-0.5 rounded bg-surface-elevated border border-border-default shadow text-2xs text-text-primary whitespace-nowrap"
          style={{ top: focusTip.top, left: focusTip.left, transform: "translateY(-50%)" }}
        >
          {focusTip.label}
        </div>
      )}
    </nav>
  );
}



/**
 * Multi-agent bar: loads artifacts from other active sessions and merges
 * them into the local store so everything appears in one UI.
 */
/** #460 — a session's change signal from the 10s session poll: the daemon's
 *  monotonic `revision` (covers status changes and comments), else — an older
 *  daemon without the field — the artifact count (#458). */
function changeSignal(s: { artifactCount: number; revision?: number; revisionEpoch?: string }): string {
  // #464 review — the epoch is part of the signal: a restarted daemon's counter
  // can climb back to a value this tab cached.
  return typeof s.revision === "number" ? `r${s.revisionEpoch ?? ""}:${s.revision}` : `c${s.artifactCount}`;
}

export function MultiAgentSync() {
  const addArtifact = useArtifactStore((s) => s.addArtifact);
  const addComment = useArtifactStore((s) => s.addComment);
  const updateComment = useArtifactStore((s) => s.updateComment);
  const recordResolvedDecision = useArtifactStore((s) => s.recordResolvedDecision);
  // C1 — reuse the session list App already polls into the connection store
  // (every 10s) instead of running a SECOND 5s /api/active-sessions poll here.
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const boundSessionId = useConnectionStore((s) => s.sessionId);
  // C1 review — refreshSessions sets a NEW array identity every 10s poll even
  // when unchanged; depending on the array tore down + recreated the 5s
  // interval each time. Key the effect on the id list's VALUE instead.
  const sessionKey = activeSessions.map((s) => s.sessionId).join(",");
  // #458 review (D6b) — the per-session CHANGE signal: the artifact count the
  // same 10s poll already carries (refreshSessions publishes a new list only
  // when a rendered field — incl. artifactCount — changed).
  const countKey = activeSessions.map((s) => `${s.sessionId}:${changeSignal(s)}`).join(",");
  const sessionsRef = useRef(activeSessions);
  sessionsRef.current = activeSessions;
  const boundRef = useRef(boundSessionId);
  boundRef.current = boundSessionId;
  // Bug B — track which sessions we've actually BACKFILLED (a successful
  // /api/live-session/:id that returned artifacts), NOT "which sessions do we
  // hold ≥1 artifact from". A stray WS-delivered artifact for session B no
  // longer marks B "known" and skips its full fetch. A ref (not state) so
  // adding an id doesn't re-render / churn the interval.
  const fullyLoadedSessions = useRef<Set<string>>(new Set());
  // #458 review (D6b) — the artifactCount each loaded session had when we last
  // fetched it. Broadcasts are session-scoped, so a sibling's NEW draft never
  // reaches this tab over the WS; before, a loaded session was never fetched
  // again and its new decision stayed invisible ("Nothing needs you"). A loaded
  // session is re-fetched when — and only when — its count moves, so the cost
  // follows activity: a quiet sibling costs nothing, a busy one one GET per
  // change, bounded by the existing 10s session poll.
  const fetchedCount = useRef<Map<string, string>>(new Map());
  // #460 — sessions a stale-card refusal asked to re-fetch right now.
  const forceRefresh = useRef<Set<string>>(new Set());
  // C1 — a session with ZERO artifacts is never fully-loaded (the fetch
  // returned nothing to mark), so the 30s backoff keeps polling it: that's how
  // another session's FIRST artifact gets discovered.
  const lastAttemptRef = useRef<Map<string, number>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const EMPTY_SESSION_RETRY_MS = 30_000;
  // #457 D6 — this component lives at App level (it was inside ArtifactPanel,
  // which only mounts once the BOUND session has artifacts). A store reset
  // (session switch, hydration snapshot) discards everything merged; it is
  // detected by the store generation, and (#458 review) re-merged IMMEDIATELY —
  // waiting for the next 5s tick landed the history after the arrival region's
  // settle window, so old sibling artifacts were announced as new.
  const generationRef = useRef(artifactStoreGeneration());
  const syncRef = useRef<() => Promise<void>>(async () => {});
  const acRef = useRef<AbortController | null>(null);

  syncRef.current = async () => {
    // PP3 — skip the fetch + parse + cross-session merge when the tab is
    // hidden (the timer keeps ticking but does no work / triggers no renders).
    if (typeof document !== "undefined" && document.hidden) return;
    const ac = acRef.current;
    if (!ac) return;
    const generation = artifactStoreGeneration();
    if (generation !== generationRef.current) {
      generationRef.current = generation;
      fullyLoadedSessions.current.clear();
      fetchedCount.current.clear();
      lastAttemptRef.current.clear();
    }
    for (const session of sessionsRef.current) {
      // E7 review — bail BEFORE stamping the backoff on an abort.
      if (ac.signal.aborted) return;
      const id = session.sessionId;
      // Keyed by generation: a fetch from before a reset must not block the
      // reset's own immediate re-merge.
      const flightKey = `${generation}:${id}`;
      if (inFlight.current.has(flightKey)) continue;
      const loaded = fullyLoadedSessions.current.has(id);
      if (loaded) {
        // The bound session's own changes arrive over its WS.
        if (id === boundRef.current) continue;
        if (fetchedCount.current.get(id) === changeSignal(session) && !forceRefresh.current.has(id)) continue; // nothing new
      } else {
        const last = lastAttemptRef.current.get(id) ?? 0;
        if (Date.now() - last < EMPTY_SESSION_RETRY_MS) continue;
        lastAttemptRef.current.set(id, Date.now());
      }
      inFlight.current.add(flightKey);
      try {
        const sRes = await apiGet(`${apiBase()}/api/live-session/${id}`, { signal: ac.signal });
        if (!sRes.ok) continue;
        const state = await sRes.json();
        if (ac.signal.aborted) return;
        // #457 D6 — a reset landed mid-fetch: this payload belongs to the
        // discarded store. The reset's own immediate re-sync fetches again.
        if (artifactStoreGeneration() !== generation) return;
        const artifacts: Artifact[] = state.artifacts ?? [];
        // #458 review — a session's FIRST load (or its re-merge after a reset)
        // is history: mark it before adding so nothing reads it as an arrival.
        // A re-poll of a loaded session brings genuinely new work: unmarked.
        if (!loaded) markBackfilled(artifacts.map((a) => a.id));
        for (const artifact of artifacts) addArtifact(artifact);
        // #460 — upsert: a re-poll must carry an answered/resolved question's
        // UPDATE too (addComment skips an id it already holds).
        const held = useArtifactStore.getState().comments;
        for (const comment of (state.comments ?? []) as Comment[]) {
          const bucket = held[comment.target?.artifactId ?? ""] ?? [];
          if (bucket.some((c) => c.id === comment.id)) updateComment(comment);
          else addComment(comment);
        }
        // #464 review — the sibling's recorded decision answers too, so a card
        // resolved elsewhere renders resolved (winning pick, no Select) instead
        // of a stale, actionable option grid.
        for (const d of (state.decisions ?? []) as Array<{ decisionId?: string; resolvedAt?: string; response?: { optionId?: string; reasoning?: string } }>) {
          if (d?.decisionId && d.response?.optionId) {
            recordResolvedDecision(d.decisionId, { optionId: d.response.optionId, reasoning: d.response.reasoning, resolvedAt: d.resolvedAt });
          }
        }
        forceRefresh.current.delete(id);
        // Bug B — mark fully-loaded ONLY once we've actually pulled artifacts;
        // empty sessions stay unmarked so the 30s backoff keeps polling them.
        if (artifacts.length > 0) {
          fullyLoadedSessions.current.add(id);
          fetchedCount.current.set(id, changeSignal(session));
        }
      } catch {
        /* network / abort — the next tick retries */
      } finally {
        inFlight.current.delete(flightKey);
      }
    }
  };

  useEffect(() => {
    // E7 — one controller per effect generation; cleanup aborts mid-flight.
    const ac = new AbortController();
    acRef.current = ac;
    void syncRef.current();
    // 5s cadence stays for reacting to NEWLY appearing sessions quickly; it is
    // fetch-free unless a session is new, past its empty backoff, or changed.
    const timer = setInterval(() => void syncRef.current(), 5000);
    return () => { ac.abort(); clearInterval(timer); };
  }, [sessionKey]); // Re-run when the session MEMBERSHIP changes

  // #458 review (D6b) — a sibling's count moved (the 10s poll saw it): fetch now.
  useEffect(() => {
    void syncRef.current();
  }, [countKey]);

  // #460 — a stale-card refusal (verdict_already_final) on a sibling's
  // artifact: re-fetch that session now, whatever its signal says.
  useEffect(() => {
    const onRefresh = (e: Event) => {
      const sid = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sid) return;
      forceRefresh.current.add(sid);
      void syncRef.current();
    };
    window.addEventListener(REFRESH_SESSION_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_SESSION_EVENT, onRefresh);
  }, []);

  // #458 review — re-merge immediately after a store reset (generation bump).
  useEffect(
    () => useArtifactStore.subscribe(() => {
      if (artifactStoreGeneration() !== generationRef.current) void syncRef.current();
    }),
    [],
  );

  return null; // No visual output — just syncs data
}

export function ArtifactPanel() {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const selectedArtifactId = useArtifactStore((s) => s.selectedArtifactId);
  const unreadIds = useArtifactStore((s) => s.unreadIds);
  const sidebarCollapsed = usePreferencesStore((s) => s.sidebarCollapsed);
  const toggleSidebar = usePreferencesStore((s) => s.toggleSidebar);
  const sidebarWidth = usePreferencesStore((s) => s.sidebarWidth);
  const isNarrow = useIsNarrowViewport();
  const effectiveCollapsed = sidebarCollapsed || isNarrow;
  const [sessionFilter, setSessionFilter] = useState<string | "all">("all");

  // Replay mode: hide artifacts created after the cursor. createdAt is ISO
  // so string comparison matches chronological order.
  const replayActive = useReplayStore((s) => s.active);
  const replayCursor = useReplayStore((s) => s.cursor);

  // New-item locator — which artifacts arrived LIVE (a store delta after the
  // first population). Tracked against the full store set (not the filtered
  // view) so a session-filter toggle doesn't masquerade as an arrival, and
  // never on initial load / reload. Suppressed entirely during replay, where a
  // "new item" has no meaning (the panel hides post-cursor artifacts).
  const nextUpBar = usePreferencesStore((s) => s.nextUpBar);
  const { highlightedIds, announcement } = useArrivalHighlights(artifacts, !replayActive, nextUpBar);

  // Unique session IDs present in the store
  const sessionIds = useMemo(
    () => [...new Set(artifacts.map((a) => a.sessionId))],
    [artifacts],
  );

  const visibleArtifacts = useMemo(
    () => artifacts.filter((a) => {
      if (a.status !== "superseded" &&
          (sessionFilter === "all" || a.sessionId === sessionFilter)) {
        // When replaying, drop artifacts that haven't been "created" yet at
        // the cursor so the side bar reflects the state as of that moment.
        if (replayActive && replayCursor && a.createdAt > replayCursor) return false;
        return true;
      }
      return false;
    }),
    [artifacts, sessionFilter, replayActive, replayCursor],
  );

  const liveCount = (sid: string | "all") =>
    artifacts.filter((a) => a.status !== "superseded" && (sid === "all" || a.sessionId === sid)).length;
  const agentsMenu = nextUpBar && !effectiveCollapsed && sessionIds.length > 1 ? (
    <label className="flex items-center gap-1.5 px-2 pb-1.5 text-2xs text-text-muted">
      <span className="shrink-0">Agents</span>
      <select
        value={sessionFilter}
        onChange={(e) => setSessionFilter(e.target.value)}
        data-testid="agents-filter-menu"
        className="flex-1 min-w-0 bg-surface-elevated border border-border-default rounded px-1 py-0.5 text-2xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
      >
        <option value="all">All ({liveCount("all")})</option>
        {sessionIds.map((sid, i) => (
          <option key={sid} value={sid} title={sid}>Agent {i + 1} ({liveCount(sid)})</option>
        ))}
      </select>
    </label>
  ) : null;

  // Group by type
  const typeGroups = useMemo(() => {
    const groups = new Map<string, Artifact[]>();
    for (const a of visibleArtifacts) {
      const list = groups.get(a.type) ?? [];
      list.push(a);
      groups.set(a.type, list);
    }
    // Bug4 — explicit createdAt (oldest→newest) sort within each bucket so the
    // order is deterministic instead of leaning on store insertion order.
    for (const list of groups.values()) {
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return groups;
  }, [visibleArtifacts]);

  const selectedArtifact = artifacts.find((a) => a.id === selectedArtifactId);

  if (visibleArtifacts.length === 0) {
    return <FirstRunWalkthrough />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* #457 D6 — MultiAgentSync (other sessions' artifacts) is mounted by
          App now, so it runs even while the bound session is empty. */}

      {/* Polite, visually-hidden announcement of live arrivals so screen-reader
          users learn a new artifact came in without depending on the visual
          glow. One line per arrival event (a burst collapses to a count). */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="arrival-live-region"
      >
        {announcement}
      </div>

      {/* Session filter — shown when artifacts from multiple agents exist.
          #430 PR 5 (design §4.6) — with the Next-up bar ON it becomes a filter
          menu in the sidebar header (it filters, it does not signal); the row
          stays whenever the sidebar is collapsed (no header room) and with the
          bar OFF. */}
      {sessionIds.length > 1 && !agentsMenu && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-default bg-surface-secondary overflow-x-auto shrink-0">
          <span className="text-2xs text-text-muted shrink-0">Agents:</span>
          <button
            onClick={() => setSessionFilter("all")}
            className={`px-2 py-0.5 rounded text-2xs shrink-0 transition-colors ${
              sessionFilter === "all"
                ? "bg-accent-blue-dim text-accent-blue font-medium"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            All ({artifacts.filter((a) => a.status !== "superseded").length})
          </button>
          {sessionIds.map((sid, i) => {
            const count = artifacts.filter((a) => a.sessionId === sid && a.status !== "superseded").length;
            return (
              <button
                key={sid}
                onClick={() => setSessionFilter(sid)}
                className={`px-2 py-0.5 rounded text-2xs shrink-0 transition-colors ${
                  sessionFilter === sid
                    ? "bg-accent-blue-dim text-accent-blue font-medium"
                    : "text-text-muted hover:text-text-secondary"
                }`}
                title={sid}
              >
                Agent {i + 1} ({count})
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
      {/* Left sidebar */}
      <ArtifactSidebar
        typeGroups={typeGroups}
        artifacts={visibleArtifacts}
        selectedArtifactId={selectedArtifactId}
        unreadIds={unreadIds}
        highlightedIds={highlightedIds}
        collapsed={effectiveCollapsed}
        headerExtra={agentsMenu}
        width={SIDEBAR_WIDTHS[sidebarWidth]}
        onToggle={toggleSidebar}
      />

      {/* Detail pane */}
      <div className="flex-1 flex flex-col min-w-0">
        <AnimatePresence mode="popLayout">
          {selectedArtifact ? (
            // Per-artifact boundary: a renderer crash on malformed content is
            // isolated to THIS pane — the sidebar (outside this subtree) stays
            // usable so the user can pick another artifact. Keying by id remounts
            // a fresh boundary on selection change, so switching away from a
            // broken artifact auto-recovers (no manual "Try again" loop on the
            // same crashing content).
            <ErrorBoundary
              key={selectedArtifact.id}
              fallback={
                <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
                  <p className="text-sm text-accent-red font-medium">This artifact failed to render</p>
                  <p className="text-xs text-text-muted max-w-xs">
                    Its content may be malformed. Pick another artifact from the sidebar — the rest of the session is unaffected.
                  </p>
                </div>
              }
            >
              <ArtifactDetail artifact={selectedArtifact} />
            </ErrorBoundary>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-text-muted">
              Select an artifact to view details
            </div>
          )}
        </AnimatePresence>
      </div>
      </div>
    </div>
  );
}
