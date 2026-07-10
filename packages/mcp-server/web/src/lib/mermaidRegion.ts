/**
 * #140 — geometry + hit-testing for region-anchored comments on Mermaid
 * diagrams. Kept pure (no React, DOM reads isolated to `collectDiagramNodes`)
 * so the normalization + intersection logic is unit-testable without jsdom
 * layout (jsdom returns all-zero getBoundingClientRect).
 *
 * A "region" is a rectangle NORMALIZED to the SVG's own rendered box (0..1) so
 * it survives responsive scaling, plus the ids + labels of the `g.node`
 * elements it covers. The rect is retained mainly to disambiguate a selection
 * spanning multiple nodes and to re-draw the highlight later.
 */

export interface PxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A rectangle in the SVG's normalized (0..1) coordinate box. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramNode {
  id: string;
  label: string;
  rect: NormRect;
}

export interface RegionTarget extends NormRect {
  elementIds?: string[];
  labels?: string[];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Normalize a pixel rectangle to the host's (SVG's) rendered box → 0..1. Clamps
 * to the box so a drag that runs past the diagram edge still yields an in-box
 * region. A zero-size host degrades to a zero rect instead of dividing by zero.
 */
export function normalizeRect(sel: PxRect, host: PxRect): NormRect {
  const width = host.right - host.left;
  const height = host.bottom - host.top;
  if (!(width > 0) || !(height > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = clamp01((sel.left - host.left) / width);
  const x1 = clamp01((sel.right - host.left) / width);
  const y0 = clamp01((sel.top - host.top) / height);
  const y1 = clamp01((sel.bottom - host.top) / height);
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

/** Do two normalized rects overlap? A shared zero-width edge does NOT count. */
export function intersects(a: NormRect, b: NormRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Below this pixel span in BOTH axes a drag is a click, not a region — so a
 * stray click/tap on the diagram never posts an empty selection. Measured in
 * client pixels (pre-normalization) so the threshold is screen-honest.
 */
export const CLICK_PX = 4;

export function isClickDrag(sel: PxRect): boolean {
  return Math.abs(sel.right - sel.left) < CLICK_PX && Math.abs(sel.bottom - sel.top) < CLICK_PX;
}

/**
 * Hit-test: the ids + labels of the nodes a normalized region overlaps. Order
 * follows the node list (document order). Empty-string ids/labels are dropped
 * so the payload never carries blanks.
 */
export function hitTestNodes(region: NormRect, nodes: DiagramNode[]): { elementIds: string[]; labels: string[] } {
  const elementIds: string[] = [];
  const labels: string[] = [];
  for (const n of nodes) {
    if (!intersects(region, n.rect)) continue;
    if (n.id) elementIds.push(n.id);
    if (n.label) labels.push(n.label);
  }
  return { elementIds, labels };
}

/** Build a RegionTarget for a drag: normalize + hit-test in one step. */
export function regionFromDrag(sel: PxRect, host: PxRect, nodes: DiagramNode[]): RegionTarget {
  const rect = normalizeRect(sel, host);
  const { elementIds, labels } = hitTestNodes(rect, nodes);
  return { ...rect, elementIds, labels };
}

/** Build a RegionTarget anchored to a single node (the keyboard path). */
export function regionFromNode(node: DiagramNode): RegionTarget {
  return {
    ...node.rect,
    elementIds: node.id ? [node.id] : [],
    labels: node.label ? [node.label] : [],
  };
}

/**
 * Two regions are "the same" (for threading a new comment onto an existing
 * one) when they cover the same set of node ids. Falls back to a coarse rect
 * match for id-less regions so blank-area selections still thread sanely.
 */
export function sameRegion(a: RegionTarget, b: RegionTarget): boolean {
  const aIds = (a.elementIds ?? []).filter(Boolean);
  const bIds = (b.elementIds ?? []).filter(Boolean);
  if (aIds.length > 0 || bIds.length > 0) {
    if (aIds.length !== bIds.length) return false;
    const as = [...aIds].sort();
    const bs = [...bIds].sort();
    return as.every((id, i) => id === bs[i]);
  }
  const r = (n: number) => Math.round(n * 100);
  return r(a.x) === r(b.x) && r(a.y) === r(b.y) && r(a.w) === r(b.w) && r(a.h) === r(b.h);
}

/**
 * Read the `g.node` elements out of a rendered Mermaid SVG and normalize each
 * one's bounding box to the SVG's rendered box. DOM-impure by necessity; the
 * geometry it delegates to is pure. Returns [] when the SVG is missing.
 */
export function collectDiagramNodes(svg: SVGSVGElement | null): DiagramNode[] {
  if (!svg) return [];
  const host = svg.getBoundingClientRect();
  const hostPx: PxRect = { left: host.left, top: host.top, right: host.right, bottom: host.bottom };
  const out: DiagramNode[] = [];
  const seen = new Set<string>();
  svg.querySelectorAll("g.node").forEach((g) => {
    const el = g as SVGGraphicsElement;
    const r = el.getBoundingClientRect();
    const id = el.id || "";
    // De-dupe by id so a node that mermaid nests twice isn't double-counted.
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    out.push({
      id,
      label: (el.textContent ?? "").trim().replace(/\s+/g, " "),
      rect: normalizeRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, hostPx),
    });
  });
  return out;
}

/** True when NONE of a region's referenced node ids still exist in the diagram
 *  (the diagram was revised and the node was removed). The comment must still
 *  render — this only drives the "node is gone" honesty note. */
export function regionNodesMissing(region: RegionTarget, nodes: DiagramNode[]): boolean {
  const ids = (region.elementIds ?? []).filter(Boolean);
  if (ids.length === 0) return false;
  const present = new Set(nodes.map((n) => n.id));
  return !ids.some((id) => present.has(id));
}
