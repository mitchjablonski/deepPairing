/**
 * #166 — AA re-tint of the vitesse syntax palettes for our surface-code grounds.
 *
 * Found by #187's light-theme axe scan — the FIRST light scan ever to mount a
 * highlighted snippet: vitesse-light's string color #B07D48 measured 3.27:1 on
 * the light surface-code (#f4f5f7). The follow-up audit (tokenizing all 13
 * shipped grammars in both themes) showed it wasn't one token: 16 of
 * vitesse-light's emitted colors and 4 of vitesse-dark's fail the 4.6 house
 * floor (#149/#150: 4.5 is WCAG AA; 4.6 survives antialiasing/animation-frame
 * sampling). The dark scans had always been green only because the seeded
 * snippet was a single identifier — dark punctuation (#666666, 3.20:1) and the
 * alpha-muted comment/quote colors had never been mounted under axe either.
 *
 * Mechanism: shiki `colorReplacements`, scoped per theme (keys must be the
 * LOWERCASE original token colors, including 8-digit alpha forms — shiki
 * matches replacement keys via color.toLowerCase()). highlighter.ts passes
 * this map to codeToTokens, so replacement happens at tokenization time.
 *
 * Every replacement preserves the original hue+saturation (HSL) and only moves
 * lightness until the color clears >=4.6 with margin (targets land ~4.7) — the
 * palette still reads as vitesse, just darkened (light) / lifted (dark).
 * Alpha-muted originals (quotes, markdown link urls, dark comments) are
 * re-tinted from their RENDERED composite over surface-code and shipped
 * opaque, so they keep their muted look instead of snapping to full-strength
 * ink. That makes each replacement exact against the surface-code ground the
 * app actually renders code on (index.css: dark #12141c, light #f4f5f7).
 *
 * Locked by web/src/__tests__/syntax-token-contrast.test.ts, which runs the
 * REAL highlight pipeline (this map included) over all 13 grammars and
 * asserts every emitted color >=4.6 against the surface-code values parsed
 * from index.css. Before/after ratios below are against those grounds.
 */
export const SYNTAX_COLOR_REPLACEMENTS: Record<
  "vitesse-light" | "vitesse-dark",
  Record<string, string>
> = {
  "vitesse-light": {
    // comments (grey-green)                          2.14 -> 4.69
    "#a0ada0": "#627262",
    // punctuation/brackets (grey)                    2.61 -> 4.74
    "#999999": "#6d6d6d",
    // variables/properties (amber-brown — the #187 finding)  3.28 -> 4.71
    "#b07d48": "#8f653a",
    // json keys / literal constants (olive)          3.40 -> 4.78
    "#998418": "#7d6c14",
    // json key quotes (olive @ 47% alpha; composite 1.68 -> opaque muted 4.76)
    "#99841877": "#786d39",
    // types/classes (teal)                           3.59 -> 4.70
    "#2e8f82": "#277a6f",
    // strings (warm terracotta)                      3.75 -> 4.72
    "#b56959": "#a45949",
    // string quotes (terracotta @ 47% alpha; composite 1.75 -> opaque muted 4.72)
    "#b5695977": "#9f5b4d",
    // functions (green)                              3.89 -> 4.73
    "#59873a": "#4f7833",
    // markdown blockquotes (cyan)                    4.18 -> 4.72
    "#2e808f": "#2b7784",
    // diff additions (green)                         4.24 -> 4.70
    "#22863a": "#207e36",
    // regex (rust-orange)                            4.37 -> 4.69
    "#ab5e3f": "#a45a3c",
    // keywords (muted red)                           4.47 -> 4.70
    "#ab5959": "#a85555",
    // tags/builtins (burnt orange)                   4.52 -> 4.69
    "#a65e2b": "#a25c2a",
    // numbers (blue-teal)                            4.56 -> 4.74
    "#2f798a": "#2e7687",
    // markdown link urls (ink @ 56% alpha; composite 3.14 -> opaque muted 4.70)
    "#393a3490": "#6d6e6c",
  },
  "vitesse-dark": {
    // punctuation/brackets (grey)                    3.20 -> 4.72
    "#666666": "#818181",
    // comments (sage @ 87% alpha; composite 3.84 -> opaque 4.70)
    "#758575dd": "#758576",
    // string quotes (rose @ 47% alpha; composite 2.35 -> opaque muted 4.73)
    "#c98a7d77": "#9e7876",
    // json key quotes (olive @ 47% alpha; composite 2.64 -> opaque muted 4.73)
    "#b8a96577": "#89825a",
  },
};
