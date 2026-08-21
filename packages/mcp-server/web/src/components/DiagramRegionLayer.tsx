import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
// #185 feel round — 288 was cramped for real comments (same lesson as the
// workbench's roomy composer): 400 default, still clamped to the well width.
const POPOVER_WIDTH = 400;

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
  chromeHost,
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
  /**
   * Q4 review (H1/H2/M3) — where the FLOW chrome goes.
   *
   * This layer emits two very different kinds of UI. The OVERLAY (highlights,
   * marquee, anchored popover) is canvas-anchored and must stay inside the
   * diagram's positioned wrapper. The CHROME (the ⌨ keyboard node-picker, the
   * locator list, the narrow-viewport block composer) is ordinary flow content
   * that belongs BELOW the diagram.
   *
   * Once MermaidDiagram capped the well at 60vh with internal scroll, the
   * chrome — being a sibling inside that wrapper — got swallowed by the
   * scrollport: at ≤900px a drag opened the block composer 817-834px below the
   * visible area at 0% visibility WITH FOCUS INSIDE IT, exactly #185's founding
   * bug in a worse form. Passing a host element portals the chrome OUT of the
   * scrollport to a sibling after the well, so it is always on screen.
   *
   * Omit it (DecisionDiagramFocus, tests) and the chrome renders inline exactly
   * as before — there is no scrollport there to escape.
   */
  chromeHost?: HTMLElement | null;
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
  /**
   * Q4 review (H2) — the VISIBLE window onto the well.
   *
   * `wellSize` is the positioned wrapper, which after the 60vh cap is sized to
   * the WHOLE diagram, not to what you can see. Clamping the popover to it put
   * a mid-scroll "below" placement outside the visible 540px — measured 17.8%
   * visible, Send unreachable. The popover math now clamps to the scrollport
   * (clientWidth/Height) with the anchor rect translated into scrollport
   * coordinates and the scroll offset added back to the result.
   *
   * `scrollTop`/`scrollLeft` are 0 and the size equals `wellSize` whenever
   * there is no scrollport (every non-capped host), so the math degrades to
   * exactly what it was.
   */
  const [port, setPort] = useState<{ width: number; height: number; scrollTop: number; scrollLeft: number } | null>(null);
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
  /** The scrolling ancestor the diagram is clipped by, if any (MermaidDiagram's
   *  capped well marks itself). Generic attribute, not a mermaid class, so any
   *  future capped host opts in the same way. */
  const scrollPortEl = useCallback(
    () => (overlayRef.current?.parentElement?.closest("[data-dp-scrollport]") as HTMLElement | null) ?? null,
    [],
  );

  /** Q4 review (H2) — cheap, scroll-frequency update: offsets only. Deliberately
   *  NOT `measure()`, which re-walks every `g.node` in the diagram; that ran per
   *  scroll frame would be the expensive kind of correct. */
  const syncScroll = useCallback(() => {
    const p = scrollPortEl();
    if (!p) return;
    setPort((prev) =>
      prev &&
      prev.width === p.clientWidth &&
      prev.height === p.clientHeight &&
      prev.scrollTop === p.scrollTop &&
      prev.scrollLeft === p.scrollLeft
        ? prev
        : { width: p.clientWidth, height: p.clientHeight, scrollTop: p.scrollTop, scrollLeft: p.scrollLeft },
    );
  }, [scrollPortEl]);

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
    syncScroll();
  }, [svgEl, syncScroll]);

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

  // Q4 review (H2) — measure() listened to resize + a new svg only, so a popover
  // anchored before a scroll kept its pre-scroll clamp. Track the scrollport.
  useEffect(() => {
    const p = scrollPortEl();
    if (!p) return;
    p.addEventListener("scroll", syncScroll, { passive: true });
    return () => p.removeEventListener("scroll", syncScroll);
  }, [scrollPortEl, syncScroll, svg]);

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
  // Q4 review (H1) — hoisted above the focus effect below, which now reads
  // `narrow` in its dependency array: leaving the declaration further down
  // put it in the temporal dead zone at render time (a ReferenceError, not a
  // lint nit). Same values, same hook order, declared before first use.
  const narrow = useIsNarrowViewport();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  useEffect(() => {
    if (!active) return;
    // Move focus to the composer's textarea once it mounts. #185 — preventScroll:
    // the composer is now a popover ANCHORED at the selection, so focusing it
    // must NOT auto-scroll (the exact yank field feedback reported — the old
    // below-diagram block, focused, scrolled a large diagram to the bottom and
    // away from the region you just drew). Belt-and-braces even if the popover
    // is partially offscreen.
    //
    // Q4 review (H1) — but preventScroll alone is only half the contract when
    // the composer is the narrow BLOCK: it sits in flow below the diagram, so
    // at 900px it opened 30% visible (measured) while holding focus — better
    // than the 0% the review found, still a control you can't see. Bring it
    // into view FIRST, minimally (`block: "nearest"`), then focus without
    // scrolling again.
    //
    // This does not re-create #185's yank: that bug existed because the block
    // sat below an UNCAPPED 1954px diagram, so reaching it pushed the diagram
    // off screen entirely. The 60vh cap is what makes scrolling to the
    // composer cheap — at most ~540px of diagram is above it. The popover
    // placement (wide viewports) still never scrolls at all.
    // scrollIntoView?.() — optional chain for jsdom (no layout engine).
    if (narrow) composerRef.current?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
    composerRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, [active, narrow]);

  // --- #185 popover placement -------------------------------------------------
  // The composer opens as a floating popover anchored to the selection rect,
  // EXCEPT on genuinely narrow (mobile-ish) widths, where there's no room for a
  // sane popover and we degrade to the legacy below-diagram block. Reduced
  // motion is honoured for the smooth-scroll of reverse-nav (below).
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
  // Q4 review (H2) — the bounds the popover must fit inside. With a capped well
  // that is the SCROLLPORT (what you can see), not the full-height wrapper;
  // without one the two are the same box and this is a no-op.
  const viewBounds = port
    ? { width: port.width || wellSize.width, height: port.height || wellSize.height }
    : wellSize;
  const scrollTop = port?.scrollTop ?? 0;
  const scrollLeft = port?.scrollLeft ?? 0;
  const popoverWidth = Math.min(POPOVER_WIDTH, viewBounds.width || POPOVER_WIDTH);
  const anchoredPos = (() => {
    if (!activePxRect || narrow) return null;
    // Into scrollport coordinates, place, then back into content coordinates
    // (the popover is positioned inside the scrolling wrapper, so it must be
    // expressed in the same space as the highlights it sits beside).
    const rectInView = {
      left: activePxRect.left - scrollLeft,
      top: activePxRect.top - scrollTop,
      width: activePxRect.width,
      height: activePxRect.height,
    };
    const p = positionPopover(rectInView, viewBounds, { width: popoverWidth, height: popoverSize.height });
    return { ...p, left: p.left + scrollLeft, top: p.top + scrollTop };
  })();

  // #185 feel round — the popover is user-draggable by its header (the flip
  // heuristic can't always pick the spot the human wants on a busy diagram).
  // dragOffset is a delta on top of the anchored position, clamped to the well,
  // and reset whenever a NEW region is selected (each selection re-anchors).
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const dragStart = useRef<{ px: number; py: number; dx: number; dy: number } | null>(null);
  const activeKey = active ? `${active.x}|${active.y}|${active.w}|${active.h}` : "";
  const lastActiveKey = useRef(activeKey);
  if (lastActiveKey.current !== activeKey) {
    lastActiveKey.current = activeKey;
    if (dragOffset.dx !== 0 || dragOffset.dy !== 0) setDragOffset({ dx: 0, dy: 0 });
  }
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only the header drags; don't let the pointerdown reach anything that
      // could start a NEW region drag or dismiss the composer.
      e.stopPropagation();
      e.preventDefault();
      dragStart.current = { px: e.clientX, py: e.clientY, dx: dragOffset.dx, dy: dragOffset.dy };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [dragOffset.dx, dragOffset.dy],
  );
  const onHandlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Belt: pointermove ALSO fires on a plain hover. If no button is held
    // (buttons === 0) this is a hover, not a drag — so heal any stale dragStart
    // (left behind by a pointercancel, an Esc-mid-drag, or a remount) and bail,
    // rather than letting the popover chase the cursor.
    if (e.buttons === 0) {
      dragStart.current = null;
      return;
    }
    const s = dragStart.current;
    if (!s) return;
    setDragOffset({ dx: s.dx + (e.clientX - s.px), dy: s.dy + (e.clientY - s.py) });
  }, []);
  const onHandlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragStart.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);
  const onHandlePointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // The browser reclaiming the pointer (OS gesture, touch/pen takeover) aborts
    // the drag cleanly — mirror pointerup so a LATER hover over the header can't
    // resume moving the popover from the interrupted drag's stale start.
    dragStart.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  // Final position: anchored + user delta. Drag bounds are DELIBERATELY looser
  // than the well (feel round 2): in a short well an in-well clamp collapses
  // the vertical range to ~zero (only left/right moved), and "pull it below
  // the diagram, out of the way" is the whole point of dragging. So the box
  // may be pulled up to DRAG_BELOW px past the well's bottom and slightly past
  // the sides — as long as enough of the header stays reachable to drag back.
  const DRAG_BELOW = 320;
  const DRAG_EDGE = 64; // px of the box that must remain inside horizontally
  // Q4 review (H2) — the drag bounds follow the popover into scrollport space:
  // clamped relative to what's VISIBLE (scroll offset + viewport), not to the
  // full-height wrapper, so dragging can't park the box off-screen either.
  const popoverPos = anchoredPos
    ? {
        ...anchoredPos,
        left: Math.max(
          scrollLeft - (popoverWidth - DRAG_EDGE),
          Math.min(anchoredPos.left + dragOffset.dx, Math.max(scrollLeft, scrollLeft + viewBounds.width - DRAG_EDGE)),
        ),
        top: Math.max(
          scrollTop,
          Math.min(anchoredPos.top + dragOffset.dy, scrollTop + viewBounds.height + DRAG_BELOW),
        ),
      }
    : null;

  // #185 feel round — focus-after-send dead zone. Sending from the popover
  // clears + briefly disables the textarea, so the browser blurs it and
  // activeElement falls to <body>: a follow-up Escape then hit nothing (it
  // neither closed the popover nor, in a modal host, the host modal). When a
  // NEW comment lands for the ACTIVE region, pull focus back to the composer's
  // textarea — preventScroll, the same contract as the open-focus effect — so
  // the layered-Esc dismissal and keep-typing both survive a send. Baselined
  // per active region so opening a region that already has comments doesn't
  // steal focus (that's the open-focus effect's job); only a growth in the
  // active region's own thread while it stays selected re-focuses.
  //
  // TWO guards keep this from STEALING focus (review): re-focus ONLY when
  //  (a) the growth is a HUMAN-authored comment — an AGENT reply arriving over
  //      WS (answer-question inherits the parent's region target, so it passes
  //      the regionComments filter and grows the count) must never move focus
  //      while the human types elsewhere; AND
  //  (b) focus is still RECLAIMABLE — activeElement is <body> (the send's own
  //      disabled-textarea blur) or already inside the popover — never yank
  //      focus the user has since moved into another field.
  const activeRegionComments = active
    ? regionComments.filter((c) => sameRegion(c.target.region as RegionTarget, active))
    : [];
  const activeThreadCount = activeRegionComments.length;
  // Author of the most-recently-created comment in this thread (ISO timestamps
  // sort lexicographically; a human send's provisional carries `now`).
  const newestAuthor = activeThreadCount
    ? activeRegionComments.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).author
    : null;
  const sentBaseline = useRef<{ key: string; count: number }>({ key: activeKey, count: activeThreadCount });
  useEffect(() => {
    const base = sentBaseline.current;
    if (base.key !== activeKey) {
      // A different region (or closed): re-baseline; open-focus handles focus.
      sentBaseline.current = { key: activeKey, count: activeThreadCount };
      return;
    }
    if (activeThreadCount > base.count && newestAuthor === "human") {
      const ae = typeof document !== "undefined" ? document.activeElement : null;
      const popover = composerRef.current;
      // Reclaim focus ONLY if the send lost it (fell to <body>) or it's still in
      // the popover — never if the user has moved into some other field.
      const reclaimable = !ae || ae === document.body || (popover != null && popover.contains(ae));
      if (reclaimable) popover?.querySelector("textarea")?.focus({ preventScroll: true });
    }
    sentBaseline.current = { key: activeKey, count: activeThreadCount };
  }, [activeKey, activeThreadCount, newestAuthor]);

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
    // Zero-area / one-pixel drag = a click, not a region. Feel round 3: a
    // CLICK on an existing region highlight re-opens that region's thread —
    // the highlight itself is the way back in once the composer was closed
    // (the rects are pointer-events-none, so we hit-test here instead).
    if (isClickDrag(sel)) {
      const px = sel.left - (wrap?.left ?? 0) - box.left;
      const py = sel.top - (wrap?.top ?? 0) - box.top;
      let best: { region: RegionTarget; area: number } | null = null;
      for (const c of regionComments) {
        const r = c.target.region as RegionTarget;
        const rl = r.x * box.width;
        const rt = r.y * box.height;
        const rw = r.w * box.width;
        const rh = r.h * box.height;
        if (px >= rl && px <= rl + rw && py >= rt && py <= rt + rh) {
          const area = rw * rh;
          if (!best || area < best.area) best = { region: r, area };
        }
      }
      if (best) openRegion(best.region);
      return;
    }
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
  const renderComposerInner = (draggable: boolean) => active ? (
    <>
      <div
        className={`flex items-center gap-2 ${draggable ? "cursor-grab active:cursor-grabbing select-none -m-1 p-1 rounded hover:bg-surface-hover" : ""}`}
        {...(draggable
          ? {
              onPointerDown: onHandlePointerDown,
              onPointerMove: onHandlePointerMove,
              onPointerUp: onHandlePointerUp,
              onPointerCancel: onHandlePointerCancel,
              title: "Drag to move this comment box",
            }
          : {})}
      >
        <span className="text-2xs font-medium text-text-secondary">Commenting on {activeLabel}</span>
        <button
          type="button"
          onClick={closeRegion}
          aria-label="Cancel region comment"
          onPointerDown={(e) => e.stopPropagation()}
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
        roomy
      />
    </>
  ) : null;

  /**
   * Q4 review (H1/H2/M3) — SLOT 1: canvas-anchored. Everything here is
   * positioned against the diagram and therefore has to live inside the
   * scrolling wrapper, scrolling WITH the diagram it annotates.
   */
  const overlaySlot = (
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

      {/* #185 — Composer for the active region. It reuses the SAME CommentThread
          / submitComment path as every other comment (so the human's note flows
          through check_feedback → revise_artifact unchanged) and the SAME focus
          contract (focus moves into the textarea on open, Esc/Cancel restores).
          Only the PLACEMENT changed: a floating popover ANCHORED to the selection
          rect inside the well (positioned below the rect, flipping above/beside
          when there's no room, clamped to the VISIBLE well, never occluding the
          rect), so composing happens at the point of action instead of yanking a
          large diagram to a below-the-fold block. On genuinely narrow
          (mobile-ish) widths there's no room for a sane popover, so we degrade
          to the block placement — which lives in the chrome slot below, OUTSIDE
          the scrollport. */}
      {active && !narrow && popoverPos && (
        <div
          ref={composerRef}
          data-testid="dp-region-popover"
          data-placement={popoverPos.placement}
          onKeyDown={onComposerKeyDown}
          className="absolute z-[3] p-2.5 bg-surface-elevated border border-accent-blue/30 rounded-lg shadow-lg space-y-2"
          style={{ left: popoverPos.left, top: popoverPos.top, width: popoverWidth }}
        >
          {renderComposerInner(true)}
        </div>
      )}
    </>
  );

  /**
   * Q4 review (H1/H2/M3) — SLOT 2: ordinary FLOW content that belongs BELOW the
   * diagram and must never be clipped by it. MermaidDiagram portals this out of
   * the capped well; hosts without a scrollport render it inline, unchanged.
   */
  const chromeSlot = (
    <>
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

      {/* The narrow-viewport composer. Q4 review (H1) — this is the placement
          that broke worst under the 60vh cap: at ≤900px (VS Code webviews
          commonly sit there) a drag opened it inside the scrollport, 817-834px
          below the visible area, at 0% visibility, WITH FOCUS INSIDE IT — no
          textarea, no Send, no Cancel anywhere on screen. In the chrome slot it
          is always in flow below the diagram. */}
      {active && narrow && (
        <div
          ref={composerRef}
          data-testid="dp-region-composer-block"
          onKeyDown={onComposerKeyDown}
          className="relative z-[2] mt-2 p-2.5 bg-surface-elevated border border-accent-blue/30 rounded-lg shadow-lg space-y-2"
        >
          {renderComposerInner(false)}
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

  return (
    <>
      {overlaySlot}
      {chromeHost ? createPortal(chromeSlot, chromeHost) : chromeHost === undefined ? chromeSlot : null}
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
