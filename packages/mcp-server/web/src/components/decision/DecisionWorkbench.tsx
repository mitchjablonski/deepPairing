import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DecisionRequestEvent, PlanVisual, Comment, CommentTarget } from "@deeppairing/shared";
import { useModal } from "../../hooks/useModal";
import { useChainComments } from "../../hooks/useChainComments";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { ConceptBadge } from "../ConceptBadge";
import { CommentThread } from "../CommentThread";
import { VisualBody } from "../ArtifactVisuals";
import { DecisionDiagramFocus } from "../DecisionDiagramFocus";
import { DecisionFooter, type DecisionFooterProps } from "./DecisionFooter";
import { badgeColors, type DecisionOption } from "./types";

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
 * SLICE 2 (deliberately deferred — gated on a separate stable-id prototype):
 *   version-aware thread carryover across a tune. Today a thread anchors to the
 *   version's artifactId (chain-aggregated on read), which is fine for slice 1.
 *   >>> CARRYOVER HOOK: when the decision supersedes to v2, this is where a
 *   thread whose (optionId + sectionId) still exists in v2 would re-anchor
 *   forward with a CARRIED marker. Not implemented in slice 1. <<<
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

/**
 * A GRAIN comment is one anchored to a part of the decision the workbench
 * renders — a whole option (optionId, no region), or an option/decision
 * SECTION (a `decision:*` sectionId, or an option-scoped section like
 * "pro:0"). Diagram REGION comments (target.region set) belong to the nested
 * #173 diagram view, not the rail — excluded here so they aren't double-shown.
 * Internal decision sectionIds (revision-request / horizon-check) aren't grain.
 */
export function isGrainComment(c: Comment): boolean {
  const t = c.target;
  if (t.region) return false; // diagram region comment — lives in the zoom view
  if (t.sectionId && t.sectionId.startsWith("decision:")) return true;
  if (t.optionId) {
    // option-scoped: whole option (no section) or a grain section (pro/con/summary)
    if (!t.sectionId) return true;
    return /^(pro|con|summary)/.test(t.sectionId);
  }
  return false;
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

  // The anchors to surface in the rail: any anchor with comments, plus the
  // active one (so its composer appears even before the first comment).
  const railKeys = new Set<string>(Object.keys(threadsByAnchor));
  if (activeAnchor) railKeys.add(anchorKey(activeAnchor));
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

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-start sm:items-center justify-center p-3 sm:p-6 overflow-auto"
      onClick={onClose}
    >
      <div
        {...dialogProps}
        aria-label="Discuss this decision"
        data-testid="decision-workbench"
        className="relative w-full max-w-[1040px] bg-surface-primary border border-border-default rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
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
        <div className="flex-1 min-h-0 overflow-auto grid grid-cols-1 min-[820px]:grid-cols-[1fr_300px]">
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
              />
            ))}
          </div>

          {/* Comment rail — grain threads + the active composer. */}
          <div
            className="border-t min-[820px]:border-t-0 min-[820px]:border-l border-border-subtle bg-surface-secondary flex flex-col min-w-0"
            data-testid="decision-workbench-rail"
          >
            <div className="text-2xs uppercase tracking-wide text-text-muted font-semibold px-3 pt-3 pb-1.5">
              Comments
            </div>
            <div className="flex-1 overflow-auto px-3 pb-3 space-y-3">
              {railAnchors.length === 0 && (
                <p className="text-2xs text-text-muted italic">
                  Hover any part — a pro, a con, the question — and hit 💬 to start a thread the agent
                  sees attached to that exact thing.
                </p>
              )}
              {railAnchors.map((anchor) => {
                const target = { artifactId, ...anchorTarget(anchor) };
                const key = anchorKey(anchor);
                const isActive = activeAnchor != null && anchorKey(activeAnchor) === key;
                return (
                  <div
                    key={key}
                    data-testid="workbench-thread"
                    className={`rounded-lg border p-2.5 ${
                      isActive ? "border-border-focus bg-surface-elevated" : "border-border-default bg-surface-elevated"
                    }`}
                  >
                    <div className="font-mono text-2xs text-accent-blue mb-1.5 truncate" title={anchor.label}>
                      ◈ {anchor.label}
                    </div>
                    <CommentThread
                      artifactId={artifactId}
                      comments={threadsByAnchor[key] ?? []}
                      target={target}
                      placeholder="Comment on this — the agent sees it anchored here…"
                      submitLabel="Comment"
                      textareaLabel={`Comment on ${anchor.label}`}
                      secondarySubmitLabel="Ask"
                      secondarySubmitTitle="Ask the agent a question anchored to this part"
                    />
                  </div>
                );
              })}
            </div>
          </div>
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
  onExpandDiagram: (visual: PlanVisual) => void;
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
}: WorkbenchColumnProps) {
  const title = option.title;
  return (
    <div className={`flex flex-col min-w-0 ${lastInRow ? "" : "min-[820px]:border-r"} border-border-subtle`}>
      {/* Column head — name, recommended chip, per-option comment count, chips. */}
      <div className="px-3.5 pt-3 pb-2.5 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-text-primary truncate">{title}</h4>
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
              className="ml-auto text-2xs font-semibold text-accent-blue bg-accent-blue-dim rounded px-1.5 py-0.5 shrink-0"
              title={`${commentCount} comment${commentCount === 1 ? "" : "s"} on this option`}
              data-testid="option-comment-count"
            >
              {commentCount} 💬
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <span className={`px-1.5 py-0.5 text-2xs rounded ${badgeColors[option.effort]}`}>effort: {option.effort}</span>
          <span className={`px-1.5 py-0.5 text-2xs rounded ${badgeColors[option.risk]}`}>{option.risk} risk</span>
          <span className="group inline-flex ml-auto">
            {renderAffordance({ optionId: option.id, label: `${title} · whole option` })}
          </span>
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
              <div key={i} className="group flex items-start gap-1.5 text-xs -mx-1 px-1 rounded hover:bg-surface-hover">
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
              <div key={i} className="group flex items-start gap-1.5 text-xs -mx-1 px-1 rounded hover:bg-surface-hover">
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
