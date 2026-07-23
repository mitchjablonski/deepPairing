import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DecisionRequestEvent, PlanVisual, Comment, CommentTarget } from "@deeppairing/shared";
import { useModal } from "../../hooks/useModal";
import { useChainComments } from "../../hooks/useChainComments";
import { useArtifactStore } from "../../stores/artifact";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { ConceptBadge } from "../ConceptBadge";
import { CommentThread } from "../CommentThread";
import { VisualBody } from "../ArtifactVisuals";
import { DecisionDiagramFocus } from "../DecisionDiagramFocus";
import { DecisionFooter, type DecisionFooterProps } from "./DecisionFooter";
import { badgeColors, type DecisionOption } from "./types";
// #180 — the carryover read-model + its marker are now SHARED (./carryover +
// ./CarryoverBadge) so the default decision surfaces render the same signal.
// The workbench's rendered behavior is byte-unchanged — only the import source
// moved. Re-exported below so existing importers (DecisionCard, the carryover
// test) keep resolving them from here.
import { computeCarryover, isGrainComment, orphanGrainLabel, type CarryoverState } from "./carryover";
import { CarryoverBadge } from "./CarryoverBadge";
export { computeCarryover, isGrainComment, CarryoverBadge, type CarryoverState };

/**
 * #174 SLICE 1 — the focused DECISION WORKBENCH ("Expand to discuss").
 *
 * The inline DecisionCard stays CLEAN: it gains ONE "💬 Discuss" affordance;
 * all the deliberation grain lives here. This dialog lays the options out
 * SIDE-BY-SIDE as columns (compare across a row, not scroll three stacked
 * cards) and makes every part commentable at the right grain — a specific
 * pro/con, an option's summary, the whole option, the decision question —
 * anchored via the decision comment targets ALREADY in the schema
 * (`optionId` + `sectionId`; NO schema change).
 *
 * Reuse, not rebuild:
 *   - decision-level actions (choose / reject / send-back) reuse DecisionFooter
 *     verbatim (the exact prop bundle DecisionCard already threads), plus the
 *     same per-option onSelect handler for the column "Choose" buttons.
 *   - grain comments reuse CommentThread (Comment + Ask intents, the shipped
 *     composer) and useChainComments (version-chain aggregation on read).
 *   - an option's diagram nests #173's DecisionDiagramFocus unchanged — the two
 *     focused views STACK (workbench = decision-level frame, diagram view = one
 *     zoom deeper).
 *   - a real dialog via the app-wide useModal contract (focus trap + Esc +
 *     restore).
 *
 * SLICE 2a (#177 — SHIPPED): version-aware thread carryover across a tune.
 *   A grain thread already renders on v2 because it buckets by (optionId +
 *   sectionId) IGNORING target.artifactId (useChainComments aggregates the
 *   chain on read). This slice makes the carry HONEST — each thread computes a
 *   read-side carryover state from the version chain and shows a marker:
 *     - CARRIED (green) — a cross-version thread whose part still lives in v2
 *       AND whose anchored text is UNCHANGED across the tune (stable option id
 *       makes this reliable for whole-option + summary + the decision question).
 *     - STALE (amber) — same, but the anchored text CHANGED (reworded summary,
 *       retitled option) — "does your comment still apply?". A read-side text
 *       diff, NO persisted field.
 *     - ORPHAN (red) — a carried thread whose (optionId) no longer matches any
 *       live v2 part (option removed / id changed) — "from v1 · no longer in
 *       this decision", replacing the confusing raw-id degraded label.
 *   See computeCarryover / CarryoverBadge in ./carryover + ./CarryoverBadge
 *   (#180 extracted them there — SHARED with the default decision surfaces).
 *   >>> CARRYOVER HOOK: slice 2a done here. SLICE 2b (still gated on a schema
 *   change) — reliable per-PRO/CON re-anchor. Pros/cons are `string[]` anchored
 *   POSITIONALLY (optionId|pro:N), so a cross-version pro/con comment is treated
 *   as STALE/uncertain (never confident CARRIED). Turning that green requires
 *   pros/cons → {id,text} + a migration — OUT OF SCOPE here. <<<
 */

/** A commentable part of the decision — the grain a comment anchors to. */
interface GrainAnchor {
  optionId?: string;
  sectionId?: string;
  /** Human label for the rail + composer header ("Redis · pro"). */
  label: string;
}

/** Build the CommentTarget for an anchor (artifactId filled by the caller). */
function anchorTarget(a: GrainAnchor): Partial<CommentTarget> {
  return {
    ...(a.optionId ? { optionId: a.optionId } : {}),
    ...(a.sectionId ? { sectionId: a.sectionId } : {}),
  };
}

/** Stable key so threads bucket per anchor (Record, never Map — store rule). */
function anchorKey(t: { optionId?: string; sectionId?: string }): string {
  return `${t.optionId ?? ""}|${t.sectionId ?? ""}`;
}

export interface DecisionWorkbenchProps {
  event: DecisionRequestEvent;
  /** Required — grain comments + the nested diagram view anchor to it. */
  artifactId: string;
  stakes?: "low" | "medium" | "high";
  /** The EXACT bundle DecisionCard threads into the inline DecisionFooter —
   *  reused verbatim so choose / reject / send-back behave identically here. */
  footerProps: DecisionFooterProps;
  onClose: () => void;
}

export function DecisionWorkbench({ event, artifactId, stakes, footerProps, onClose }: DecisionWorkbenchProps) {
  // A real modal: focus moves in, Tab is trapped, Esc closes and focus restores
  // to the Discuss button that opened it (the useModal contract).
  const { dialogProps } = useModal({ onClose });

  // The grain part whose composer is OPEN in the rail. Clicking a part's
  // affordance activates it; an anchor that already has comments always shows.
  const [activeAnchor, setActiveAnchor] = useState<GrainAnchor | null>(null);
  // #173 nested zoom — an option's diagram opened in the region-commenting view.
  const [focusedDiagram, setFocusedDiagram] = useState<
    { optionId: string; optionTitle: string; visual: PlanVisual } | null
  >(null);
  // Pop-out — one option focused full-width (compare grid ⇄ dwell on one).
  const [focusedOptionId, setFocusedOptionId] = useState<string | null>(null);

  const artifacts = useArtifactStore((s) => s.artifacts);
  const allComments = useChainComments(artifactId);
  const grainComments = allComments.filter(isGrainComment);

  // Bucket grain comments per anchor (Record, not Map — frontend store rule).
  const threadsByAnchor: Record<string, Comment[]> = {};
  for (const c of grainComments) {
    const k = anchorKey(c.target);
    (threadsByAnchor[k] ??= []).push(c);
  }

  const countFor = (t: { optionId?: string; sectionId?: string }): number =>
    threadsByAnchor[anchorKey(t)]?.length ?? 0;

  // #177 slice 2a — the read-side carryover state of a grain thread across a
  // tune (CARRIED / STALE / ORPHAN / none). Derived from the version chain +
  // the live v2 options; no persisted field.
  const carryoverFor = (anchor: { optionId?: string; sectionId?: string }): CarryoverState =>
    computeCarryover({
      artifacts,
      thread: threadsByAnchor[anchorKey(anchor)] ?? [],
      currentArtifactId: artifactId,
      anchor,
      liveOptions: event.options,
    });

  const isAnchorActive = (a: GrainAnchor): boolean =>
    activeAnchor?.optionId === a.optionId && activeAnchor?.sectionId === a.sectionId;

  // The grain-comment affordance for a part. IMPORTANT: renders the MODULE-LEVEL
  // WorkbenchGrainButton (stable component identity) — an inline component would
  // get a fresh identity on every re-render (e.g. when a diagram finishes
  // rendering async), remounting the buttons and dropping keyboard focus to
  // <body> (the a11y focus-trap regression this cost a debug round to find).
  const affordance = (anchor: GrainAnchor, className?: string): ReactNode => (
    <WorkbenchGrainButton
      label={anchor.label}
      count={countFor(anchorTarget(anchor))}
      active={isAnchorActive(anchor)}
      onActivate={() => setActiveAnchor(anchor)}
      className={className}
    />
  );

  // Per-option total (the mockup's "N comments" indicator — #173 review flagged
  // it was never implemented): every grain comment scoped to this option.
  const optionCommentCount = (optionId: string): number =>
    grainComments.filter((c) => c.target.optionId === optionId).length;

  const optionTitleFor = (optionId?: string): string =>
    event.options.find((o) => o.id === optionId)?.title ?? optionId ?? "";

  const gridCols =
    event.options.length >= 3
      ? "grid-cols-1 min-[820px]:grid-cols-3"
      : "grid-cols-1 min-[820px]:grid-cols-2";

  // The anchors to surface in the rail — MODE-COHERENT with the pop-out so a
  // whole-option comment never shows in two places at once:
  //   - GRID mode: every anchor with comments (INCLUDING whole-option "opt|"
  //     keys) plus the active one. The column-head 💬 is the whole-option entry
  //     point in the grid, so whole-option threads belong in the rail here.
  //   - POP-OUT mode: whole-option "opt|" keys are excluded — the focused view's
  //     inline "Comment or ask about {option}" composer is their SOLE surface,
  //     so they can't double-show (rail + inline). Section keys are unaffected.
  const railKeys = new Set<string>(
    Object.keys(threadsByAnchor).filter((k) => !(focusedOptionId != null && k.endsWith("|"))),
  );
  // Guard the active-anchor re-add: a bare-optionId (whole-option) anchor must
  // NOT rejoin the rail while popped out even if some path set it — the inline
  // composer owns it there. (The head 💬 that could set it is itself suppressed
  // in the focused column, so this is defensive.)
  if (activeAnchor && !(focusedOptionId != null && !activeAnchor.sectionId)) {
    railKeys.add(anchorKey(activeAnchor));
  }
  const railAnchors: GrainAnchor[] = Array.from(railKeys).map((k) => {
    const [optionId, sectionId] = k.split("|");
    // Prefer the active anchor's label (freshest); else derive from a comment.
    if (activeAnchor && anchorKey(activeAnchor) === k) return activeAnchor;
    return {
      optionId: optionId || undefined,
      sectionId: sectionId || undefined,
      label: sectionLabel(optionTitleFor(optionId || undefined), sectionId || undefined),
    };
  });

  const focusedOption = focusedOptionId
    ? event.options.find((o) => o.id === focusedOptionId) ?? null
    : null;

  // The comment rail only claims width once there's actually something to
  // discuss (a thread, or a composer the human just opened). Empty, it would
  // squish the options — so before the first comment the options get the full
  // width (like the inline card), and the rail slides in when you start one.
  const hasRail = railAnchors.length > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-start sm:items-center justify-center p-3 sm:p-6 overflow-auto"
      onClick={onClose}
    >
      <div
        {...dialogProps}
        aria-label="Discuss this decision"
        data-testid="decision-workbench"
        className="relative w-full max-w-[1280px] bg-surface-primary border border-border-default rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onKeyDown={(e) => {
          // Layered Esc: from a popped-out option, first return to the compare
          // grid; only from the grid does Esc collapse the workbench. Override
          // useModal's onKeyDown and delegate to it only when NOT focused.
          if (e.key === "Escape" && focusedOptionId) {
            e.preventDefault();
            e.stopPropagation();
            setFocusedOptionId(null);
            // Drop any composer opened while popped out so it doesn't linger in
            // the grid rail after returning (same cleanup as ← Back).
            setActiveAnchor(null);
            return;
          }
          dialogProps.onKeyDown(e);
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Breadcrumb header — Decision ▸ Discuss + the question (commentable). */}
        <div className="flex items-start gap-2 px-4 py-2.5 border-b border-border-subtle bg-surface-secondary">
          <span className="mt-0.5 text-2xs font-bold tracking-wide text-accent-amber bg-accent-amber-dim rounded px-1.5 py-0.5 shrink-0">
            DECISION
          </span>
          {stakes && stakes !== "low" && (
            <span
              className={`mt-0.5 text-2xs font-medium uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 ${
                stakes === "high" ? "bg-accent-red-dim text-accent-red" : "bg-accent-amber-dim text-accent-amber"
              }`}
              title={stakes === "high" ? "High stakes — the agent flagged this as consequential" : "Medium stakes"}
            >
              {stakes} stakes
            </span>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <SimpleMarkdown text={event.context} className="text-sm font-semibold text-text-primary" />
              <span className="group inline-flex">
                {affordance({ sectionId: "decision:question", label: "the decision question" })}
              </span>
            </div>
            <div className="text-2xs text-text-muted mt-0.5">
              {event.options.length} options · here's where you weigh them together
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Collapse to the decision card"
            className="ml-auto shrink-0 text-2xs text-text-muted hover:text-text-primary border border-border-default rounded px-2 py-1 bg-surface-elevated transition-colors press-scale"
          >
            Esc · Collapse to card
          </button>
        </div>

        {/* Body — option columns on the left, comment rail on the right. */}
        <div className={`flex-1 min-h-0 overflow-auto grid grid-cols-1 ${hasRail ? "min-[820px]:grid-cols-[1fr_384px]" : ""}`}>
          {focusedOption ? (
            <div className="flex flex-col min-w-0" data-testid="workbench-focused-option">
              <button
                onClick={() => {
                  // Return to the grid AND drop any composer activated while
                  // popped out, so a stray section composer doesn't linger in
                  // the grid rail after Back / when re-popping a different option.
                  setFocusedOptionId(null);
                  setActiveAnchor(null);
                }}
                className="self-start m-2 text-2xs font-semibold text-text-secondary hover:text-accent-blue border border-border-default rounded px-2 py-1 bg-surface-elevated transition-colors press-scale"
              >
                ← Back to all options
              </button>
              <WorkbenchColumn
                key={focusedOption.id}
                option={focusedOption}
                artifactId={artifactId}
                lastInRow
                focused
                commentCount={optionCommentCount(focusedOption.id)}
                onChoose={() => {
                  footerProps.onSelect(focusedOption.id);
                  onClose();
                }}
                renderAffordance={affordance}
                onExpandDiagram={(visual) =>
                  setFocusedDiagram({ optionId: focusedOption.id, optionTitle: focusedOption.title, visual })
                }
                onActivateAnchor={setActiveAnchor}
              />
              {/* Whole-option comment/ask — a persistent composer below the
                  focused option (not hover-gated), anchored to the option
                  itself (optionId, no section). */}
              <div className="px-3.5 py-3 border-t border-border-subtle">
                <div className="text-2xs uppercase tracking-wide text-text-muted font-semibold mb-2">
                  Comment or ask about {focusedOption.title}
                </div>
                <CarryoverBadge state={carryoverFor({ optionId: focusedOption.id })} />
                <CommentThread
                  artifactId={artifactId}
                  comments={threadsByAnchor[`${focusedOption.id}|`] ?? []}
                  target={{ artifactId, optionId: focusedOption.id }}
                  placeholder={`Comment on ${focusedOption.title} as a whole — the agent sees it on this option…`}
                  submitLabel="Comment"
                  textareaLabel={`Comment on ${focusedOption.title}`}
                  secondarySubmitLabel="Ask"
                  secondarySubmitTitle={`Ask the agent a question about ${focusedOption.title}`}
                  roomy
                />
              </div>
            </div>
          ) : (
            <div className={`grid ${gridCols}`}>
              {event.options.map((option, idx) => (
                <WorkbenchColumn
                  key={option.id}
                  option={option}
                  artifactId={artifactId}
                  lastInRow={idx === event.options.length - 1}
                  commentCount={optionCommentCount(option.id)}
                  onChoose={() => {
                    // Reuse the card's exact selection handler, then collapse —
                    // the card behind resolves (or shows the high-stakes
                    // prediction capture) with the workbench out of the way.
                    footerProps.onSelect(option.id);
                    onClose();
                  }}
                  renderAffordance={affordance}
                  onExpandDiagram={(visual) =>
                    setFocusedDiagram({ optionId: option.id, optionTitle: option.title, visual })
                  }
                  onFocus={() => setFocusedOptionId(option.id)}
                  onActivateAnchor={setActiveAnchor}
                />
              ))}
            </div>
          )}

          {/* Comment rail — only claims width once there's a thread/composer;
              before that the options get the full width (see hasRail). */}
          {hasRail && (
          <div
            className="border-t min-[820px]:border-t-0 min-[820px]:border-l border-border-subtle bg-surface-secondary flex flex-col min-w-0"
            data-testid="decision-workbench-rail"
          >
            <div className="text-2xs uppercase tracking-wide text-text-muted font-semibold px-3 pt-3 pb-1.5">
              Comments
            </div>
            <div className="flex-1 overflow-auto px-3 pb-3 space-y-3">
              {railAnchors.map((anchor) => {
                const target = { artifactId, ...anchorTarget(anchor) };
                const key = anchorKey(anchor);
                const isActive = activeAnchor != null && anchorKey(activeAnchor) === key;
                const carryover = carryoverFor(anchor);
                const isOrphan = carryover.kind === "orphan";
                return (
                  <div
                    key={key}
                    data-testid="workbench-thread"
                    data-carryover={carryover.kind}
                    className={`rounded-lg border p-2.5 ${
                      isActive ? "border-border-focus bg-surface-elevated" : "border-border-default bg-surface-elevated"
                    }`}
                  >
                    {/* ORPHAN: the option is gone, so `anchor.label` leaks the
                        raw option id (optionTitleFor's degraded fallback). Show a
                        generic grain label + the red "no longer in this decision"
                        badge instead — never the confusing raw id. */}
                    {isOrphan ? (
                      <div className="font-mono text-2xs text-accent-red mb-1.5 truncate" data-testid="orphan-label">
                        ◈ {orphanGrainLabel(anchor.sectionId)}
                      </div>
                    ) : (
                      <div className="font-mono text-2xs text-accent-blue mb-1.5 truncate" title={anchor.label}>
                        ◈ {anchor.label}
                      </div>
                    )}
                    <CarryoverBadge state={carryover} />
                    <CommentThread
                      artifactId={artifactId}
                      comments={threadsByAnchor[key] ?? []}
                      target={target}
                      placeholder="Comment on this — the agent sees it anchored here…"
                      submitLabel="Comment"
                      textareaLabel={`Comment on ${anchor.label}`}
                      secondarySubmitLabel="Ask"
                      secondarySubmitTitle="Ask the agent a question anchored to this part"
                      roomy
                    />
                  </div>
                );
              })}
            </div>
          </div>
          )}
        </div>

        {/* Decision-level actions — reuse DecisionFooter verbatim. */}
        <div className="border-t border-border-default bg-surface-secondary px-4 py-1">
          <DecisionFooter {...footerProps} />
        </div>
      </div>

      {/* #173 — the nested diagram region-commenting view. The two focused
          views STACK; reused unchanged (its own useModal + backdrop). */}
      {focusedDiagram && (
        <DecisionDiagramFocus
          artifactId={artifactId}
          optionId={focusedDiagram.optionId}
          optionTitle={focusedDiagram.optionTitle}
          visual={focusedDiagram.visual}
          onClose={() => setFocusedDiagram(null)}
        />
      )}
    </div>,
    document.body,
  );
}

/**
 * A grain-comment affordance for a commentable part. MODULE-LEVEL (stable
 * component identity) so re-renders of the workbench — e.g. a diagram
 * finishing its async render — never remount it and steal keyboard focus.
 * Shows a count when threads exist; clicking activates that anchor's composer.
 */
function WorkbenchGrainButton({
  label,
  count,
  active,
  onActivate,
  className,
}: {
  label: string;
  count: number;
  active: boolean;
  onActivate: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-grain-affordance
      onClick={onActivate}
      aria-label={`Comment on ${label}${count > 0 ? ` (${count} comment${count === 1 ? "" : "s"})` : ""}`}
      className={`inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs font-semibold transition-colors press-scale ${
        active
          ? "bg-accent-blue-strong text-white"
          : count > 0
            ? "bg-accent-blue-dim text-accent-blue hover:bg-accent-blue-dim/80"
            : "text-text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-surface-hover hover:text-accent-blue"
      } ${className ?? ""}`}
    >
      <span aria-hidden="true">💬</span>
      {count > 0 && <span>{count}</span>}
    </button>
  );
}

/** Friendly label for a grain section id (pro:0 → "pro", con:1 → "con"). */
function sectionLabel(optionTitle: string, sectionId?: string): string {
  if (!sectionId) return optionTitle ? `${optionTitle} · whole option` : "option";
  if (sectionId === "decision:question") return "the decision question";
  if (sectionId === "summary") return `${optionTitle} · summary`;
  if (sectionId.startsWith("pro")) return `${optionTitle} · pro`;
  if (sectionId.startsWith("con")) return `${optionTitle} · con`;
  return `${optionTitle} · ${sectionId}`;
}

interface WorkbenchColumnProps {
  option: DecisionOption;
  artifactId: string;
  lastInRow: boolean;
  commentCount: number;
  onChoose: () => void;
  renderAffordance: (anchor: GrainAnchor, className?: string) => ReactNode;
  /** Click anywhere on a section row to open its composer (mouse convenience;
   *  the 💬 button inside each row stays the keyboard/SR-accessible trigger). */
  onActivateAnchor?: (anchor: GrainAnchor) => void;
  onExpandDiagram: (visual: PlanVisual) => void;
  /** Pop this option out to a focused, full-width view. Omitted when the
   *  column IS the focused view (so it doesn't offer to focus itself). */
  onFocus?: () => void;
  /** True when this column IS the focused (popped-out) view. Suppresses the
   *  column-head WHOLE-OPTION 💬 affordance — in the pop-out the persistent
   *  inline "Comment or ask about {option}" composer is the sole whole-option
   *  surface, so the head 💬 (which opened a rail composer) would double it. */
  focused?: boolean;
}

/**
 * One option as a COLUMN — summary, pros/cons (each a commentable grain row),
 * effort/risk chips, and its diagram (with the #173 expand-to-comment zoom).
 * Composes the existing render pieces (SimpleMarkdown, ConceptBadge,
 * badgeColors, VisualBody) — the decision rendering isn't rebuilt from scratch.
 */
function WorkbenchColumn({
  option,
  artifactId,
  lastInRow,
  commentCount,
  onChoose,
  renderAffordance,
  onExpandDiagram,
  onFocus,
  onActivateAnchor,
  focused,
}: WorkbenchColumnProps) {
  const title = option.title;
  return (
    <div className={`flex flex-col min-w-0 ${lastInRow ? "" : "min-[820px]:border-r"} border-border-subtle`}>
      {/* Column head — name, recommended chip, per-option comment count, chips. */}
      <div className="px-3.5 pt-3 pb-2.5 border-b border-border-subtle">
        <div className="flex items-center gap-2 min-w-0">
          <h4 className="flex-1 min-w-0 text-sm font-semibold text-text-primary truncate">{title}</h4>
          {option.recommendation && (
            <span
              className="text-2xs font-bold tracking-wide text-accent-violet bg-accent-violet-dim rounded px-1.5 py-0.5 shrink-0"
              title="Agent recommends this option"
            >
              ★ Recommended
            </span>
          )}
          {commentCount > 0 && (
            <span
              className="text-2xs font-semibold text-accent-blue bg-accent-blue-dim rounded px-1.5 py-0.5 shrink-0"
              title={`${commentCount} comment${commentCount === 1 ? "" : "s"} on this option`}
              data-testid="option-comment-count"
            >
              {commentCount} 💬
            </span>
          )}
          {onFocus && (
            <button
              onClick={onFocus}
              aria-label="Pop out this option to a focused, full-width view"
              title="Pop out this option to a focused, full-width view"
              data-testid="option-popout"
              className="shrink-0 inline-flex items-center justify-center w-6 h-6 text-xs text-text-secondary hover:text-accent-blue border border-border-default hover:border-accent-blue rounded bg-surface-elevated transition-colors press-scale"
            >
              ⤢
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <span className={`px-1.5 py-0.5 text-2xs rounded ${badgeColors[option.effort]}`}>effort: {option.effort}</span>
          <span className={`px-1.5 py-0.5 text-2xs rounded ${badgeColors[option.risk]}`}>{option.risk} risk</span>
          {/* Whole-option 💬 — the grid's entry point for a comment on the option
              as a whole. Suppressed in the focused (pop-out) column, where the
              persistent inline composer below is the sole whole-option surface. */}
          {!focused && (
            <span className="group inline-flex ml-auto">
              {renderAffordance({ optionId: option.id, label: `${title} · whole option` })}
            </span>
          )}
        </div>
        {option.concept?.name && (
          <div className="mt-2">
            <ConceptBadge name={option.concept.name} explanation={option.concept.oneLineExplanation} size="md" />
          </div>
        )}
      </div>

      {/* Summary */}
      <div className="group px-3.5 py-2.5 border-b border-border-subtle">
        <div className="flex items-center justify-between gap-2">
          <div className="text-2xs uppercase tracking-wide text-text-muted font-semibold">Summary</div>
          {renderAffordance({ optionId: option.id, sectionId: "summary", label: `${title} · summary` })}
        </div>
        <SimpleMarkdown text={option.description} className="text-xs text-text-secondary mt-1 space-y-1" />
      </div>

      {/* Pros — each a commentable grain row */}
      {Array.isArray(option.pros) && option.pros.length > 0 && (
        <div className="px-3.5 py-2.5 border-b border-border-subtle">
          <div className="text-2xs uppercase tracking-wide text-text-muted font-semibold mb-1">Pros</div>
          <div className="space-y-0.5">
            {option.pros.map((pro, i) => (
              <div
                key={i}
                onClick={() => onActivateAnchor?.({ optionId: option.id, sectionId: `pro:${i}`, label: `${title} · pro` })}
                className="group flex items-start gap-1.5 text-xs -mx-1 px-1 rounded hover:bg-surface-hover cursor-pointer"
              >
                <span className="text-accent-green shrink-0 mt-0.5" aria-hidden="true">✓</span>
                <span className="text-text-secondary flex-1 min-w-0">{pro}</span>
                {renderAffordance({ optionId: option.id, sectionId: `pro:${i}`, label: `${title} · pro` })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cons — each a commentable grain row */}
      {Array.isArray(option.cons) && option.cons.length > 0 && (
        <div className="px-3.5 py-2.5 border-b border-border-subtle">
          <div className="text-2xs uppercase tracking-wide text-text-muted font-semibold mb-1">Cons</div>
          <div className="space-y-0.5">
            {option.cons.map((con, i) => (
              <div
                key={i}
                onClick={() => onActivateAnchor?.({ optionId: option.id, sectionId: `con:${i}`, label: `${title} · con` })}
                className="group flex items-start gap-1.5 text-xs -mx-1 px-1 rounded hover:bg-surface-hover cursor-pointer"
              >
                <span className="text-accent-red shrink-0 mt-0.5" aria-hidden="true">✗</span>
                <span className="text-text-secondary flex-1 min-w-0">{con}</span>
                {renderAffordance({ optionId: option.id, sectionId: `con:${i}`, label: `${title} · con` })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Architecture diagram(s) — read-only preview + the #173 expand-to-comment
          zoom (region commenting goes live in the nested focused view). */}
      {Array.isArray(option.visuals) && option.visuals.length > 0 && (
        <div className="px-3.5 py-2.5 border-b border-border-subtle space-y-2">
          <div className="text-2xs uppercase tracking-wide text-text-muted font-semibold">Architecture</div>
          {option.visuals.map((v) => (
            <div key={v.id} className="group relative bg-surface-secondary rounded-lg border border-white/[0.06] p-2 space-y-1">
              {v.kind === "diagram" && (
                <button
                  type="button"
                  onClick={() => onExpandDiagram(v)}
                  aria-label={`Expand the ${title} option's ${v.title || "diagram"} to comment`}
                  className="absolute top-1.5 right-1.5 z-10 inline-flex items-center gap-1 rounded px-1.5 py-1 text-2xs font-semibold text-white bg-accent-blue-strong shadow-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus transition-opacity press-scale"
                >
                  <span aria-hidden="true">⤢</span> Expand to comment
                </button>
              )}
              {v.title && <div className="text-2xs text-text-muted">{v.title}</div>}
              <VisualBody artifactId={artifactId} visual={v} readOnly />
              {v.caption && <div className="text-2xs text-text-secondary leading-relaxed">{v.caption}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Per-option Choose — reuses the card's onSelect handler. */}
      <div className="mt-auto p-2.5">
        <button
          type="button"
          onClick={onChoose}
          aria-label={`Choose ${title}`}
          className={`w-full px-3 py-1.5 text-xs font-semibold rounded press-scale transition-colors border ${
            option.recommendation
              ? "border-accent-green/50 bg-accent-green-dim text-accent-green hover:bg-accent-green-dim/80"
              : "border-border-default bg-surface-elevated text-text-secondary hover:bg-accent-blue-strong hover:text-white hover:border-accent-blue-strong"
          }`}
        >
          {option.recommendation ? "✓ " : ""}Choose {title}
        </button>
      </div>
    </div>
  );
}
