import type { StepNodeState } from "../components/SkeletonFences";

/**
 * Skeleton plans, parity PR 3 — a skeleton plan's architecture diagram tracks
 * step status, like the standalone skeleton-skills review: a Mermaid node whose
 * id is `step_<id>` (dots and dashes as underscores, so step `2.1` is
 * `step_2_1`) is coloured AND patterned by that step's fence status, carries a
 * text cue (an SVG <title> and a glyph), and jumps to the fence when clicked.
 *
 * Decoration is DOM-only, after mermaid renders: the source and the SVG string
 * are untouched, so the region-comment layer (which reads node labels and
 * rects) sees the same diagram.
 */

/** `2.1` → `2_1`: the node-id spelling of a step id. */
export const stepNodeKey = (skelId: string): string => `step_${skelId.replace(/[.-]/g, "_")}`;

/** True when the Mermaid source names at least one of these steps' nodes. */
export function sourceHasStepNodes(source: string, skelIds: string[]): boolean {
  return skelIds.some((id) => new RegExp(`(^|[^A-Za-z0-9_])${stepNodeKey(id)}([^A-Za-z0-9_]|$)`).test(source));
}

/** Mermaid's rendered node ids end in `flowchart-<nodeId>-<n>`
 *  (e.g. `dp-mmd-7-8-flowchart-step_2_1-0`). */
const NODE_ID = /flowchart-(step_[A-Za-z0-9_]+)-\d+$/;

const STATUS_TEXT: Record<StepNodeState["status"], string> = {
  pending: "Pending",
  filled: "Filled",
  active: "Active",
  unknown: "Not in the code view",
};
const GLYPH: Record<StepNodeState["status"], string> = { pending: "○", filled: "●", active: "▶", unknown: "?" };

/** Decorate every step node in `host`'s SVG. Returns the undo (for effect cleanup). */
export function decorateStepNodes(
  host: HTMLElement,
  states: Record<string, StepNodeState>,
  onJump: (skelId: string) => void,
): () => void {
  const byKey: Record<string, StepNodeState> = {};
  for (const s of Object.values(states)) byKey[stepNodeKey(s.skelId)] = s;
  const undo: Array<() => void> = [];
  host.querySelectorAll("g.node").forEach((g) => {
    const m = NODE_ID.exec(g.id || "");
    const state = m ? byKey[m[1]!] : undefined;
    if (!state) return;
    const cls = ["dp-skel-step", `dp-skel-${state.status}`];
    g.classList.add(...cls);
    g.setAttribute("data-skel-step", state.skelId);
    g.setAttribute("data-skel-status", state.status);
    const doc = g.ownerDocument;
    const title = doc.createElementNS("http://www.w3.org/2000/svg", "title");
    title.setAttribute("data-skel-cue", "title");
    title.textContent = `Step ${state.stepNumber} (SKEL[${state.skelId}]): ${STATUS_TEXT[state.status]}${state.mismatch ? `. ${state.mismatch}` : ""}`;
    g.insertBefore(title, g.firstChild);
    // A visible glyph in the node's corner (needs layout: skipped where getBBox
    // is unavailable — the <title> and the legend carry the text cue there).
    let glyph: SVGTextElement | null = null;
    const bboxOf = (g as unknown as SVGGraphicsElement).getBBox;
    if (typeof bboxOf === "function") {
      try {
        const b = (g as unknown as SVGGraphicsElement).getBBox();
        glyph = doc.createElementNS("http://www.w3.org/2000/svg", "text");
        glyph.setAttribute("class", "dp-skel-glyph");
        glyph.setAttribute("x", String(b.x + 3));
        glyph.setAttribute("y", String(b.y + 11));
        glyph.setAttribute("aria-hidden", "true");
        glyph.textContent = GLYPH[state.status];
        g.appendChild(glyph);
      } catch {
        glyph = null;
      }
    }
    // Direct clicks reach the node only where no region overlay covers it
    // (read-only views); the overlay path calls stepNodeAt instead.
    const onClick = () => onJump(state.skelId);
    g.addEventListener("click", onClick);
    undo.push(() => {
      g.classList.remove(...cls);
      g.removeAttribute("data-skel-step");
      g.removeAttribute("data-skel-status");
      title.remove();
      glyph?.remove();
      g.removeEventListener("click", onClick);
    });
  });
  return () => undo.forEach((u) => u());
}

/** The decorated step node under a client point (the region overlay's plain
 *  click), or null. */
export function stepNodeAt(host: HTMLElement | null, clientX: number, clientY: number): string | null {
  if (!host) return null;
  let hit: { id: string; area: number } | null = null;
  host.querySelectorAll("g.dp-skel-step").forEach((g) => {
    const r = g.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return;
    const area = r.width * r.height;
    const id = g.getAttribute("data-skel-step");
    if (id && (!hit || area < hit.area)) hit = { id, area };
  });
  return (hit as { id: string; area: number } | null)?.id ?? null;
}
