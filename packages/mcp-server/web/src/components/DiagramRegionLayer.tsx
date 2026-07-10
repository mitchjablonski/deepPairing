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
 */
export function DiagramRegionLayer({
  artifactId,
  visualId,
  svg,
  hostRef,
}: {
  artifactId: string;
  visualId: string;
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
    (c) => c.target.visualId === visualId && c.target.region,
  );

  // --- drag selection (mouse) ------------------------------------------------
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const wrap = overlayRef.current?.getBoundingClientRect();
    return { x: e.clientX - (wrap?.left ?? 0), y: e.clientY - (wrap?.top ?? 0) };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = localPoint(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const p = localPoint(e);
    setDrag((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
  };
  const finishDrag = (e: React.MouseEvent) => {
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
    setActive(regionFromDrag(sel, host, collectDiagramNodes(el)));
  };

  // --- keyboard path: pick a node directly -----------------------------------
  const pickNode = (node: DiagramNode) => setActive(regionFromNode(node));

  // Highlights live INSIDE the capture overlay (which is already offset to the
  // SVG box), so they're placed relative to the overlay, not the wrapper.
  const highlightStyle = (r: RegionTarget): React.CSSProperties => ({
    left: r.x * box.width,
    top: r.y * box.height,
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
      {/* Mouse drag-capture surface over the diagram. Presentational — the
          keyboard path below is the accessible equivalent, so this is hidden
          from the a11y tree and carries no role. */}
      <div
        ref={overlayRef}
        aria-hidden="true"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={finishDrag}
        onMouseLeave={(e) => drag && finishDrag(e)}
        className="absolute z-[1] cursor-crosshair"
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
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
                {n.label || n.id}
              </button>
            ))}
          </div>
        </details>
      )}

      {/* Composer for the active region — reuses the SAME CommentThread /
          submitComment path as every other comment, so the human's note flows
          through check_feedback → revise_artifact unchanged. */}
      {active && (
        <div className="relative z-[2] mt-2 p-2.5 bg-surface-elevated border border-accent-blue/30 rounded-lg shadow-lg space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-2xs font-medium text-text-secondary">Commenting on {activeLabel}</span>
            <button
              type="button"
              onClick={() => setActive(null)}
              aria-label="Cancel region comment"
              className="ml-auto text-text-muted hover:text-text-primary text-2xs"
            >
              Cancel
            </button>
          </div>
          <CommentThread
            artifactId={artifactId}
            comments={regionComments.filter((c) => sameRegion(c.target.region as RegionTarget, active))}
            target={{ visualId, region: active }}
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
                  onClick={() => setActive(r)}
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

/** Human-readable referent for a region: its labels, else its id count, else
 *  the bare rectangle. Shared by the composer header + the list rows. */
export function describeRegion(r: RegionTarget): string {
  const labels = (r.labels ?? []).filter(Boolean);
  if (labels.length > 0) return `[${labels.join(", ")}]`;
  const ids = (r.elementIds ?? []).filter(Boolean);
  if (ids.length > 0) return `[${ids.join(", ")}]`;
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
