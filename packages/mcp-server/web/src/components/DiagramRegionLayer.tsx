import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useChainComments } from "../hooks/useChainComments";
import { useMediaQuery, useIsNarrowViewport } from "../hooks/useMediaQuery";
import { CommentThread } from "./CommentThread";
import { positionPopover } from "../lib/popoverPosition";
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

/** #185 — how long the reverse-nav flash lingers on a region rect before the JS
 *  timeout clears it (matches the CSS `dp-region-flash` duration). */
const REGION_FLASH_MS = 1600;
/** #185 — fixed popover width (px). Clamped to the well when the well is
 *  narrower, so a small-but-not-mobile well never spills a fixed-width popover. */
const POPOVER_WIDTH = 288;

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
  // #185 — the WELL's own size (the positioned wrapper, overlay inset-0), so the
  // popover math clamps to the well the pins are drawn in. jsdom returns zeros.
  const [wellSize, setWellSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
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
    if (wrap) {
      const w = wrap.getBoundingClientRect();
      setWellSize({ width: w.width, height: w.height });
      if (el) {
        const s = el.getBoundingClientRect();
        setBox({ left: s.left - w.left, top: s.top - w.top, width: s.width, height: s.height });
      }
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
  // #185 — Esc cancels the composer and restores focus to its trigger. On the
  // popover this is the keyboard dismissal a floating surface needs; inside the
  // decision focused view (a useModal dialog) stopPropagation makes Esc cancel
  // the composer FIRST without also closing the host modal (the same nested-Esc
  // rule useModal itself follows). Attached to both placements so the contract
  // is identical whether the composer is a popover or the narrow-viewport block.
  const onComposerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRegion();
      }
    },
    [closeRegion],
  );
  useEffect(() => {
    if (!active) return;
    // Move focus to the composer's textarea once it mounts. #185 — preventScroll:
    // the composer is now a popover ANCHORED at the selection, so focusing it
    // must NOT auto-scroll (the exact yank field feedback reported — the old
    // below-diagram block, focused, scrolled a large diagram to the bottom and
    // away from the region you just drew). Belt-and-braces even if the popover
    // is partially offscreen.
    composerRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, [active]);

  // --- #185 popover placement -------------------------------------------------
  // The composer opens as a floating popover anchored to the selection rect,
  // EXCEPT on genuinely narrow (mobile-ish) widths, where there's no room for a
  // sane popover and we degrade to the legacy below-diagram block. Reduced
  // motion is honoured for the smooth-scroll of reverse-nav (below).
  const narrow = useIsNarrowViewport();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // Measured popover size (for the flip/clamp math). Estimate until it mounts;
  // the layout effect corrects it, and the position recomputes on the next pass.
  const [popoverSize, setPopoverSize] = useState<{ width: number; height: number }>({
    width: POPOVER_WIDTH,
    height: 200,
  });
  useLayoutEffect(() => {
    if (!active || narrow) return;
    const el = composerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Only adopt a real measurement (jsdom returns zeros — keep the estimate so
    // the pure math still has sane inputs; the geometry is covered in the unit
    // matrix, not here).
    if (r.width > 0 && r.height > 0) {
      setPopoverSize((prev) =>
        prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height },
      );
    }
  }, [active, narrow, wellSize.width, wellSize.height, box.left, box.top]);

  // The selection rect in well-local px (same conversion the highlights use).
  const activePxRect = active
    ? {
        left: box.left + active.x * box.width,
        top: box.top + active.y * box.height,
        width: active.w * box.width,
        height: active.h * box.height,
      }
    : null;
  const popoverWidth = Math.min(POPOVER_WIDTH, wellSize.width || POPOVER_WIDTH);
  const popoverPos =
    activePxRect && !narrow
      ? positionPopover(activePxRect, wellSize, { width: popoverWidth, height: popoverSize.height })
      : null;

  // --- #185 reverse navigation: click a posted region thread → find it --------
  // Clicking a region thread's anchor header scrolls the diagram so the region
  // is in view and briefly flash-highlights its rect (arrival-glow family). The
  // highlight rects are refd by comment id so we can scroll + flash the right one.
  const highlightRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  const navigateToRegion = useCallback(
    (comment: Comment) => {
      const el = highlightRefs.current[comment.id];
      // scrollIntoView?.() — optional chain for jsdom (no layout engine). Center
      // the region; honour reduced motion by skipping the smooth animation.
      el?.scrollIntoView?.({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
      setFlashId(comment.id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashId(null), REGION_FLASH_MS);
    },
    [reducedMotion],
  );

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

  // #185 — the composer's contents, shared verbatim by the popover and the
  // narrow-viewport fallback block so both placements are byte-identical inside.
  const composerInner = active ? (
    <>
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
    </>
  ) : null;

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
          const flashing = flashId === c.id;
          return (
            <div
              key={c.id}
              ref={(node) => {
                highlightRefs.current[c.id] = node;
              }}
              data-testid="dp-region-highlight"
              data-region-missing={missing ? "true" : "false"}
              data-region-flash={flashing ? "true" : "false"}
              title={`${describeRegion(r)}${missing ? " — node no longer in this diagram" : ""}`}
              className={`absolute rounded-sm pointer-events-none border ${
                missing
                  ? "border-accent-amber/70 bg-accent-amber/10"
                  : "border-accent-blue/70 bg-accent-blue/10"
              }${flashing ? " dp-region-flash" : ""}`}
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

      {/* #185 — Composer for the active region. It reuses the SAME CommentThread
          / submitComment path as every other comment (so the human's note flows
          through check_feedback → revise_artifact unchanged) and the SAME focus
          contract (focus moves into the textarea on open, Esc/Cancel restores).
          Only the PLACEMENT changed: a floating popover ANCHORED to the selection
          rect inside the well (positioned below the rect, flipping above/beside
          when there's no room, clamped to the well, never occluding the rect),
          so composing happens at the point of action instead of yanking a large
          diagram to a below-the-fold block. On genuinely narrow (mobile-ish)
          widths there's no room for a sane popover, so we degrade to the legacy
          below-diagram placement. */}
      {active && !narrow && popoverPos && (
        <div
          ref={composerRef}
          data-testid="dp-region-popover"
          data-placement={popoverPos.placement}
          onKeyDown={onComposerKeyDown}
          className="absolute z-[3] p-2.5 bg-surface-elevated border border-accent-blue/30 rounded-lg shadow-lg space-y-2"
          style={{ left: popoverPos.left, top: popoverPos.top, width: popoverWidth }}
        >
          {composerInner}
        </div>
      )}
      {active && narrow && (
        <div
          ref={composerRef}
          data-testid="dp-region-composer-block"
          onKeyDown={onComposerKeyDown}
          className="relative z-[2] mt-2 p-2.5 bg-surface-elevated border border-accent-blue/30 rounded-lg shadow-lg space-y-2"
        >
          {composerInner}
        </div>
      )}

      {/* Text mirror of the region comments — always present when there are any,
          so they're legible even before you hover a highlight, and their node
          referents (and gone-ness) are stated in words. #185 — clicking a row is
          now REVERSE NAVIGATION: it scrolls the diagram so the region is in view
          and flash-highlights its rect (the pins already mark posted threads; the
          composing moment moved to the popover, so the list is a locator). Real
          <button>s → keyboard-operable (Enter/Space) with a clickable cursor. */}
      {regionComments.length > 0 && (
        <ul className="relative z-[2] mt-1.5 space-y-0.5">
          {regionComments.map((c) => {
            const r = c.target.region as RegionTarget;
            const missing = regionNodesMissing(r, nodes);
            return (
              <li key={`t-${c.id}`} className="text-[10px] text-text-muted flex items-start gap-1">
                <span aria-hidden="true">◈</span>
                <button
                  type="button"
                  data-testid="dp-region-thread-anchor"
                  onClick={() => navigateToRegion(c)}
                  title="Show this region on the diagram"
                  className="text-left cursor-pointer hover:text-accent-blue underline-offset-2 hover:underline"
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
