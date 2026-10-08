/**
 * #430 PR 1d (docs/design/attention-hierarchy.md §2.8, §8 1d) — ONE colour for
 * "waiting on the agent": your move is done, the agent owes you (a revision, an
 * answer). It was violet in the header ❓ badge, the resume banner, the rail,
 * the AskTrigger pulse, LineComments and the `revised` dot/chip, but blue in the
 * Context Bank lane and the Comment-threads count. Blue everywhere now, from
 * this one place, so it can't drift again. Violet stays the ASK/decision family
 * (Ask buttons, question-mode composers, "Let's think this through").
 *
 * Contrast (WCAG, index.css tokens), both themes:
 *   - `text`  on `-dim` chip: dark 5.26 · light 4.83 (AA text ≥4.5)
 *   - `text`  on surface:     dark 6.44 · light 5.53
 *   - white glyph on `dot`:   5.63 in both (the old violet dot was 2.72 in dark)
 *   - `dot` vs surface:       dark 3.35 · light 5.63 (AA non-text ≥3)
 * Never colour-only: every use keeps its glyph (↻ ⏳ ❓ 💤) and a text label.
 */
export const WAITING_TONE = {
  /** Solid status dot that carries a white glyph (sidebar `revised` ↻). */
  dot: "bg-accent-blue-strong",
  /** Text / icon colour. */
  text: "text-accent-blue",
  /** Pill / chip: tinted background + text. */
  chip: "bg-accent-blue-dim text-accent-blue",
  chipHover: "hover:bg-accent-blue-dim/80",
  /** Full-width strip (resume banner). */
  strip: "bg-accent-blue-dim/50 border-b border-accent-blue/15",
} as const;
