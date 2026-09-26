/**
 * #185 — pure geometry for the region-comment POPOVER composer.
 *
 * Field feedback: after drag-selecting a region on a LARGE diagram, the composer
 * rendered as a block BELOW the diagram and focusing its textarea auto-scrolled
 * the page to the bottom — yanking you away from the region you just drew, so you
 * composed blind. The fix anchors the composer as a floating popover to the
 * selection rectangle inside the diagram well.
 *
 * This helper is the placement math, kept pure (no React, no DOM) so the
 * flip/clamp logic is unit-testable without jsdom layout (jsdom returns all-zero
 * getBoundingClientRect — the same reason mermaidRegion.ts is pure). The
 * COMPONENT decides popover-vs-legacy-block (narrow viewport → block); this
 * helper only positions the popover WITHIN the well once that choice is made.
 *
 * Coordinates are all WELL-LOCAL pixels: the selection rect and the returned
 * position are relative to the diagram well's top-left (the overlay is inset-0,
 * so well-local == overlay-local == the positioned wrapper's coordinate space).
 */

/** A rectangle in well-local pixels (the selection, or the popover). */
export interface PopoverRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

/** Which side of the selection rect the popover landed on. */
export type PopoverPlacement = "below" | "above" | "right" | "left";

export interface PopoverPosition {
  left: number;
  top: number;
  placement: PopoverPlacement;
}

/** Gap between the selection rect and the popover, in px. */
export const POPOVER_GAP = 8;

const clamp = (v: number, min: number, max: number): number =>
  max < min ? min : v < min ? min : v > max ? max : v;

/**
 * Place the popover relative to the selection rect, NEVER occluding it:
 *
 *  1. prefer BELOW the rect (top-aligned to rect.left, clamped into the well);
 *  2. if there's no vertical room below, flip ABOVE;
 *  3. if neither fits, go BESIDE — right if it fits, else left — with the
 *     vertical offset clamped into the well (beside is horizontally clear of the
 *     rect, so a vertical overlap with the rect is fine and expected);
 *  4. last resort (a well too small for any placement — the component falls back
 *     to the legacy below-diagram block before this bites), clamp a below
 *     placement into the well so the numbers are always in-bounds.
 *
 * The horizontal position for below/above aligns the popover's left edge to the
 * rect's left, then clamps so the popover never spills past the well's edges.
 *
 * #403 — the rect may lie OUTSIDE the well: the caller passes it in scrollport
 * coordinates, so a region scrolled out of view (then the well shrunk by a
 * window resize) has rect.top > well.height or a negative bottom. "Above" only
 * checked its top edge (≥ 0), so it returned a box whose bottom sat gap-above
 * an off-screen anchor — measured 83px, then 195px, past the well. Every
 * vertical result is therefore clamped into the well too; for an in-view rect
 * the fit checks already guarantee this, so the clamp is a no-op there, and
 * for an off-screen one it follows the region's nearest visible edge.
 */
export function positionPopover(
  rect: PopoverRect,
  well: PopoverSize,
  popover: PopoverSize,
  gap: number = POPOVER_GAP,
): PopoverPosition {
  const maxLeft = Math.max(0, well.width - popover.width);
  const alignedLeft = clamp(rect.left, 0, maxLeft);
  const maxTop = Math.max(0, well.height - popover.height);

  // 1 — below (clamped: a rect scrolled out ABOVE the well has belowTop < 0)
  const belowTop = rect.top + rect.height + gap;
  if (belowTop + popover.height <= well.height) {
    return { left: alignedLeft, top: clamp(belowTop, 0, maxTop), placement: "below" };
  }

  // 2 — above (clamped: a rect scrolled out BELOW the well puts this box's
  // bottom past the well's — #403)
  const aboveTop = rect.top - gap - popover.height;
  if (aboveTop >= 0) {
    return { left: alignedLeft, top: clamp(aboveTop, 0, maxTop), placement: "above" };
  }

  // 3 — beside (right, else left). Clamped into the well on both axes (the
  // horizontal clamp only bites for a rect scrolled out sideways).
  const besideTop = clamp(rect.top, 0, maxTop);
  const rightLeft = rect.left + rect.width + gap;
  if (rightLeft + popover.width <= well.width) {
    return { left: clamp(rightLeft, 0, maxLeft), top: besideTop, placement: "right" };
  }
  const leftLeft = rect.left - gap - popover.width;
  if (leftLeft >= 0) {
    return { left: clamp(leftLeft, 0, maxLeft), top: besideTop, placement: "left" };
  }

  // 4 — nothing fits: clamp a below placement so the coords stay in-bounds.
  return {
    left: alignedLeft,
    top: clamp(belowTop, 0, maxTop),
    placement: "below",
  };
}
