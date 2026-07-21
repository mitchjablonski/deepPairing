import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useChainComments } from "../hooks/useChainComments";
import { CommentThread } from "./CommentThread";
import {
  collectDiagramNodes,
  isClickDrag,
  regionFromDrag,
  regionFromNode,
  regionNodesMissing,
  sameRegion,
  type DiagramNode,
  type PxRect,
  type RegionTarget,
} from "../lib/mermaidRegion";

/**
 * #140 — region-anchored comments on a rendered Mermaid diagram.
 *
 * Drag a rectangle over the diagram (or, keyboard-only, pick a node from the
 * list) → the comment carries a TEXTUAL anchor: the hit-tested `g.node` ids +
 * labels + the normalized rect. NOT a screenshot — the labels let the agent
 * locate the node in the Mermaid source it authored and revise the diagram.
 *
 * This layer only mounts over the INTERACTIVE (non-readOnly) diagram in
 * ArtifactVisuals — never over a decision-option preview, a revision diff, or a
 * prototype sandbox (which is opaque-origin and can't be read anyway).
 *
 * Degradation contracts:
 *  - SVG failed to render → this layer is never mounted (MermaidDiagram is in
 *    its source-fallback branch); existing region comments still render as text
 *    there.
 *  - A referenced node id removed by a later diagram revision → the comment
 *    does NOT vanish: its highlight still draws from the normalized rect and
 *    its list row says the node is gone.
 *  - Zero-area / one-pixel drag → treated as a click, no region posted.
 *  - Drag strays outside the diagram → pointer capture keeps the marquee
 *    alive; on release the rect clamps back into the box (normalizeRect), so
 *    the selection completes instead of ending early at the boundary.
 */
export function DiagramRegionLayer({
  artifactId,
  visualId,
  optionId,
  svg,
  hostRef,
}: {
  artifactId: string;
  visualId: string;
  // #173 — the decision OPTION this diagram belongs to. When set, a region
  // comment anchors to optionId + visualId + region together (all three already
  // in the schema), and existing region comments are scoped to THIS option so
  // two options that happen to share a visualId can't cross-show each other's
  // notes. Omitted for plan/spec diagrams — behaves exactly as before.
  optionId?: string;
  /** The sanitized SVG markup — recompute nodes when it changes (revision). */
  svg: string;
  /** The div that hosts the injected diagram SVG. */
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [nodes, setNodes] = useState<DiagramNode[]>([]);
  // Placement of the diagram SVG within this layer's positioned wrapper, so
  // highlights + node markers overlay the SVG box (which is centered and may be
  // narrower than the wrapper). jsdom returns zeros — highlights still render.
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number }>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  // The region being commented on (from a drag or a node pick). Null = idle.
  const [active, setActive] = useState<RegionTarget | null>(null);
  // Live drag rectangle in wrapper-local px, for the marquee outline.
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const svgEl = useCallback(
    () => hostRef.current?.querySelector("svg") as SVGSVGElement | null,
    [hostRef],
  );

  // Recompute the node list + SVG placement. Cheap; runs on mount, when the
  // diagram source changes (revision), and on resize (placement only needs it,
  // but node normalized rects are resize-invariant so recomputing is harmless).
  const measure = useCallback(() => {
    const el = svgEl();
    setNodes(collectDiagramNodes(el));
    const wrap = overlayRef.current?.parentElement;
    if (el && wrap) {
      const s = el.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      setBox({ left: s.left - w.left, top: s.top - w.top, width: s.width, height: s.height });
    }
  }, [svgEl]);

  useLayoutEffect(() => {
    measure();
  }, [measure, svg]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(() => measure());
    const el = svgEl();
    if (el) ro.observe(el);
    if (overlayRef.current?.parentElement) ro.observe(overlayRef.current.parentElement);
    return () => ro.disconnect();
  }, [measure, svgEl, svg]);

  const comments = useChainComments(artifactId);
  const regionComments = comments.filter(
    (c) =>
      c.target.visualId === visualId &&
      c.target.region &&
      // #173 — scope to the option when this layer is a decision focused view.
      (optionId ? c.target.optionId === optionId : true),
  );

  // Focus management: opening the composer moves focus INTO it; closing/cancel
  // restores focus to whatever triggered it (the node button / list row), so a
  // keyboard user is never dumped on <body>. axe can't catch this — it's manual.
  const composerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const openRegion = useCallback((region: RegionTarget) => {
    const el = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    // Don't capture the aria-hidden drag overlay as a restore target (a mouse
    // drag has no meaningful focus origin — leave it null and let focus rest in
    // the composer until the user tabs out).
    triggerRef.current = el && el.getAttribute("data-testid") !== "dp-region-overlay" ? el : null;
    setActive(region);
  }, []);
  const closeRegion = useCallback(() => {
    setActive(null);
    const t = triggerRef.current;
    triggerRef.current = null;
    if (t && t.isConnected) t.focus?.();
  }, []);
  useEffect(() => {
    if (!active) return;
    // Move focus to the composer's textarea once it mounts.
    composerRef.current?.querySelector("textarea")?.focus();
  }, [active]);

  // --- drag selection (pointer) ------------------------------------------------
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const wrap = overlayRef.current?.getBoundingClientRect();
    return { x: e.clientX - (wrap?.left ?? 0), y: e.clientY - (wrap?.top ?? 0) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Capture the pointer for the drag's duration, so a marquee that strays
    // past the diagram edge keeps receiving move/up HERE and completes — with
    // normalizeRect clamping the rect back into the box — instead of ending
    // early at the boundary (the old element-bound mouse listeners finished
    // the selection the instant the pointer left the overlay). Guarded:
    // jsdom implements neither pointer capture nor PointerEvent, and a real
    // browser throws NotFoundError for an already-inactive pointerId.
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is best-effort — an uncaptured drag just behaves as before */
    }
    const p = localPoint(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = localPoint(e);
    setDrag((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
  };
  const finishDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = localPoint(e);
    const wrap = overlayRef.current?.getBoundingClientRect();
    const el = svgEl();
    const sel: PxRect = {
      left: Math.min(drag.x0, p.x) + (wrap?.left ?? 0),
      top: Math.min(drag.y0, p.y) + (wrap?.top ?? 0),
      right: Math.max(drag.x0, p.x) + (wrap?.left ?? 0),
      bottom: Math.max(drag.y0, p.y) + (wrap?.top ?? 0),
    };
    setDrag(null);
    // Zero-area / one-pixel drag = a click, not a region.
    if (isClickDrag(sel)) return;
    const s = el?.getBoundingClientRect();
    const host: PxRect = s
      ? { left: s.left, top: s.top, right: s.right, bottom: s.bottom }
      : { left: 0, top: 0, right: 0, bottom: 0 };
    openRegion(regionFromDrag(sel, host, collectDiagramNodes(el)));
  };

  // --- keyboard path: pick a node directly -----------------------------------
  const pickNode = (node: DiagramNode) => openRegion(regionFromNode(node));

  // Highlights live INSIDE the capture overlay. The overlay covers the whole
  // well (inset-0), so normalized SVG-box coords are offset by the SVG's
  // placement within the well (box.left/top).
  const highlightStyle = (r: RegionTarget): React.CSSProperties => ({
    left: box.left + r.x * box.width,
    top: box.top + r.y * box.height,
    width: r.w * box.width,
    height: r.h * box.height,
  });

  const dragRectStyle = drag
    ? {
        left: Math.min(drag.x0, drag.x1),
        top: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : null;

  const activeLabel = active ? describeRegion(active) : "";

  return (
    <>
      {/* Pointer drag-capture surface over the diagram. Presentational — the
          keyboard path below is the accessible equivalent, so this is hidden
          from the a11y tree and carries no role. cursor-crosshair = honest
          cursor over the one surface where dragging does something.

          Covers the ENTIRE well (inset-0), not just the SVG box: the well is
          flex-centered, so a narrow diagram has wide gutters that LOOK like
          capture zone (inside the visible border) but were dead — field
          feedback: "I can't select left of the login form". A drag starting
          in a gutter is clamped to the SVG box by normalizeRect, so it
          behaves as if it began at the diagram's edge. */}
      <div
        ref={overlayRef}
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        // The browser reclaiming the pointer (touch-scroll takeover, OS
        // gesture) aborts the drag cleanly — never a half-finished region.
        onPointerCancel={() => setDrag(null)}
        className="absolute inset-0 z-[1] cursor-crosshair"
        data-testid="dp-region-overlay"
      >
        {/* Existing region comments, redrawn on the diagram. */}
        {regionComments.map((c) => {
          const r = c.target.region as RegionTarget;
          const missing = regionNodesMissing(r, nodes);
          return (
            <div
              key={c.id}
              data-testid="dp-region-highlight"
              data-region-missing={missing ? "true" : "false"}
              title={`${describeRegion(r)}${missing ? " — node no longer in this diagram" : ""}`}
              className={`absolute rounded-sm pointer-events-none border ${
                missing
                  ? "border-accent-amber/70 bg-accent-amber/10"
                  : "border-accent-blue/70 bg-accent-blue/10"
              }`}
              style={highlightStyle(r)}
            />
          );
        })}
        {/* Live marquee while dragging. Animation-free; nothing to reduce. */}
        {dragRectStyle && (
          <div
            className="absolute border border-dashed border-accent-blue bg-accent-blue/10 pointer-events-none"
            style={dragRectStyle}
          />
        )}
      </div>

      {/* Accessible, keyboard-first path: comment on a specific node without a
          mouse. Native <details> → focusable summary + real buttons. */}
      {nodes.length > 0 && (
        <details className="relative z-[2] mt-1">
          <summary className="cursor-pointer select-none text-[10px] text-text-muted hover:text-text-secondary inline-flex items-center gap-1">
            <span aria-hidden="true">⌨</span> Comment on a node
          </summary>
          <div
            role="group"
            aria-label="Comment on a diagram node"
            className="mt-1 flex flex-wrap gap-1"
          >
            {nodes.map((n) => (
              <button
                key={n.id || n.label}
                type="button"
                onClick={() => pickNode(n)}
                className="px-1.5 py-0.5 rounded text-[10px] bg-surface-elevated text-text-secondary hover:bg-surface-hover hover:text-accent-blue border border-white/[0.06] transition-colors"
              >
                {n.label || "node"}
              </button>
            ))}
          </div>
        </details>
      )}

      {/* Composer for the active region — reuses the SAME CommentThread /
          submitComment path as every other comment, so the human's note flows
          through check_feedback → revise_artifact unchanged. */}
      {active && (
        <div ref={composerRef} className="relative z-[2] mt-2 p-2.5 bg-surface-elevated border border-accent-blue/30 rounded-lg shadow-lg space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-2xs font-medium text-text-secondary">Commenting on {activeLabel}</span>
            <button
              type="button"
              onClick={closeRegion}
              aria-label="Cancel region comment"
              className="ml-auto text-text-muted hover:text-text-primary text-2xs"
            >
              Cancel
            </button>
          </div>
          <CommentThread
            artifactId={artifactId}
            comments={regionComments.filter((c) => sameRegion(c.target.region as RegionTarget, active))}
            // #173 — carry optionId when this is a decision focused view, so the
            // posted comment anchors to optionId + visualId + region together.
            target={{ visualId, region: active, ...(optionId ? { optionId } : {}) }}
          />
        </div>
      )}

      {/* Text mirror of the region comments — always present when there are any,
          so they're legible even before you hover a highlight, and their node
          referents (and gone-ness) are stated in words. */}
      {regionComments.length > 0 && (
        <ul className="relative z-[2] mt-1.5 space-y-0.5">
          {regionComments.map((c) => {
            const r = c.target.region as RegionTarget;
            const missing = regionNodesMissing(r, nodes);
            return (
              <li key={`t-${c.id}`} className="text-[10px] text-text-muted flex items-start gap-1">
                <span aria-hidden="true">▢</span>
                <button
                  type="button"
                  onClick={() => openRegion(r)}
                  className="text-left hover:text-text-secondary"
                >
                  on region {describeRegion(r)}
                  {missing && <span className="text-accent-amber"> — node no longer in this diagram</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Human-readable referent for a region: its labels, else the bare rectangle.
 *  Never surfaces `elementIds` — they're render-unique and meaningless to a
 *  human (see mermaidRegion.normLabel). Shared by the composer header + rows. */
export function describeRegion(r: RegionTarget): string {
  const labels = (r.labels ?? []).filter(Boolean);
  if (labels.length > 0) return `[${labels.join(", ")}]`;
  return "a region";
}

/** Text fallback used when the diagram itself can't render (source fallback):
 *  render each region comment as a line, never crashing. */
export function RegionCommentsFallback({
  artifactId,
  visualId,
}: {
  artifactId: string;
  visualId: string;
}) {
  const comments = useChainComments(artifactId).filter(
    (c: Comment) => c.target.visualId === visualId && c.target.region,
  );
  if (comments.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-0.5">
      {comments.map((c) => (
        <li key={c.id} className="text-[10px] text-text-muted">
          on region {describeRegion(c.target.region as RegionTarget)} — {c.content}
        </li>
      ))}
    </ul>
  );
}
