import type { Artifact } from "@deeppairing/shared";
import { computeAttention, type Attention } from "./attention";
import { WAITING_TONE } from "./waitingTone";

/**
 * #430 PR 4 (docs/design/attention-hierarchy.md §5 "Sidebar status glyphs", §8)
 * — the sidebar's per-artifact lane glyph, DERIVED from `computeAttention`, so a
 * row and the Next-up bar can never disagree about which lane an artifact is in:
 *
 *   ▲ Decide  — a decision awaiting your pick          (the bar's `▲ next`)
 *   ● Review  — any other draft awaiting your verdict  (the bar's `● next`)
 *   ○ Read    — explainer/reasoning draft (PR 0's neutral dot)
 *   ◌ Waiting — `revised`: the agent owes a revision (PR 1d's one blue)
 *
 * An artifact in no lane (approved, rejected, superseded, retracted, obsolete,
 * reviewing) keeps its status mark. Questions and requests are Waiting items
 * too, but they are not rows — their anchor artifact keeps its own lane.
 *
 * Never colour-only: each lane has its own SHAPE and label. The two amber lanes
 * differ by shape (▲ vs ●) and by label.
 *
 * Contrast (index.css tokens, WCAG ratios computed; glyph on the solid dot,
 * dot on the sidebar's surface-secondary):
 *   - ▲/● `surface-primary` on amber: dark 8.41 · light 6.31
 *     (the old white-on-amber was 2.24 in dark)
 *   - ○ `surface-primary` on text-muted: dark 5.44 · light 5.48
 *     (the old white-on-muted was 3.47 in dark)
 *   - ◌ white on blue-strong: 5.63 in both (PR 1d)
 *   - dot vs sidebar, non-text ≥3: amber 7.90/5.99, muted 5.11/5.20,
 *     blue 3.15/5.35 (dark/light)
 */
export type SidebarLane = "decide" | "review" | "read" | "waiting";

export interface LaneMark {
  lane: SidebarLane;
  glyph: string;
  /** Solid dot background + glyph colour. */
  dot: string;
  /** Accessible name (also the tooltip). PR 0 / PR 1d wording, extended per lane. */
  label: string;
}

export const LANE_MARKS: Record<SidebarLane, LaneMark> = {
  decide: { lane: "decide", glyph: "▲", dot: "bg-accent-amber text-surface-primary", label: "Decision, awaiting your pick" },
  review: { lane: "review", glyph: "●", dot: "bg-accent-amber text-surface-primary", label: "Draft, awaiting review" },
  read: { lane: "read", glyph: "○", dot: "bg-text-muted text-surface-primary", label: "New — for you to read" },
  waiting: { lane: "waiting", glyph: "◌", dot: `${WAITING_TONE.dot} text-white`, label: "Revision requested — waiting on Claude" },
};

/** The bar's empty state ("Nothing needs you"). Deliberately NOT a lane glyph
 *  (PR 4 review): ○ means Read, and only Read. */
export const NOTHING_GLYPH = "◇";

/** Artifact id → its lane mark, for every artifact that is itself a lane item. */
export function laneMarksFrom(attention: Attention): Record<string, LaneMark> {
  const out: Record<string, LaneMark> = {};
  for (const d of attention.lanes.decide) {
    if (d.artifactId) out[d.artifactId] = d.kind === "decision" ? LANE_MARKS.decide : LANE_MARKS.review;
  }
  for (const r of attention.lanes.read) {
    if (r.artifactId) out[r.artifactId] = LANE_MARKS.read;
  }
  for (const w of attention.lanes.waiting) {
    // Only the artifact's OWN waiting item (a revision) — a question anchored on
    // an artifact does not re-lane that artifact.
    if (w.kind === "revision" && w.artifactId) out[w.artifactId] = LANE_MARKS.waiting;
  }
  return out;
}

/** One artifact's lane mark, or null when it is in no lane. */
export function laneMarkFor(artifact: Artifact): LaneMark | null {
  return laneMarksFrom(computeAttention({ artifacts: [artifact] }))[artifact.id] ?? null;
}
