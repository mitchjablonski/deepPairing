/**
 * R2 — the ALPHA-MODIFIER contrast class, measured from the real tokens.
 *
 * Round 13's UX lens found six sub-AA text pairings, every one of them a token
 * that already passed being pushed under 4.5:1 by an alpha modifier
 * (`/70`, `/80`, `opacity-80`, `opacity-90`) layered on top of it. The class is
 * old enough that a shipped code comment already names it — PendingBanner
 * lines 113-117: "a bare text-accent-amber/70 on the banner bg fails 4.5:1 —
 * caught by axe" — and five more shipped anyway.
 *
 * This test is the standing gate the comment couldn't be. It does two things:
 *
 *  1. MEASURES. Composites each fixed pairing exactly the way a browser does
 *     (alpha over the resolved background) using the token values parsed out of
 *     index.css, in BOTH themes, and asserts ≥ 4.5:1 at settle. The numbers in
 *     each case name are the pre-R2 measurements, so a regression reads as a
 *     diff against what was actually wrong.
 *  2. GREPS. Asserts the alpha modifiers are gone from the six source sites —
 *     because a measurement of the fixed colours proves nothing if someone
 *     re-adds `/80` to the class list. Deliberately narrow: only these lines,
 *     only these modifiers.
 *
 * No browser needed, so it runs in the normal unit sweep rather than waiting
 * for the axe e2e — which is how five of the six got through in the first place
 * (the a11y fixtures didn't mount the newest surfaces; see a11y.e2e.ts).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(webSrc, "index.css"), "utf-8");
const lightAt = css.indexOf('[data-theme="light"] {');
const darkBlock = css.slice(0, lightAt);
const lightBlock = css.slice(lightAt);

function token(name: string, theme: "dark" | "light"): string {
  const block = theme === "dark" ? darkBlock : lightBlock;
  const re = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`);
  const m = block.match(re);
  // CSS custom properties INHERIT: a token the light block doesn't redeclare
  // keeps the dark @theme value. Modelling that is the point — it is exactly
  // the mechanism that produced the #150 light-theme accent failures.
  if (!m?.[1]) {
    if (theme === "light") return token(name, "dark");
    throw new Error(`token --color-${name} not found in index.css dark block`);
  }
  return m[1];
}

type RGB = [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const over = (fg: RGB, bg: RGB, a: number): RGB =>
  fg.map((v, i) => v * a + bg[i]! * (1 - a)) as RGB;
function luminance(c: RGB): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg: RGB, bg: RGB): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * One measured pairing. `bg` is the surface stack from the bottom up — each
 * layer composited over the last at its own alpha (a `/50` wash is a layer,
 * not a colour).
 */
function measure(theme: "dark" | "light", fg: string, bg: Array<[string, number]>, fgAlpha = 1): number {
  let surface = rgb(token(bg[0]![0], theme));
  for (const [name, alpha] of bg.slice(1)) {
    surface = over(rgb(token(name, theme)), surface, alpha);
  }
  return contrast(over(rgb(token(fg, theme)), surface, fgAlpha), surface);
}

/** The six sites, with the pre-R2 measurement that made each one a finding. */
const CASES: Array<{
  name: string;
  fg: string;
  bg: Array<[string, number]>;
  before: { dark: number; light: number };
}> = [
  {
    // PreflightBlockLog.tsx — "Proposed:" label, was text-text-muted/70.
    name: 'gate-log "Proposed:" label on the popover surface',
    fg: "text-secondary", bg: [["surface-elevated", 1]],
    before: { dark: 3.02, light: 2.95 },
  },
  {
    // ChangesetArtifact.tsx — the (head → base) ref pair, was opacity-80.
    name: "external-review banner branch refs",
    fg: "accent-blue", bg: [["surface-secondary", 1], ["accent-blue-dim", 1]],
    before: { dark: 3.90, light: 3.39 },
  },
  {
    // ChangesetArtifact.tsx — "your verdicts stay local…", was opacity-90.
    name: "external-review banner semantics sentence",
    fg: "accent-blue", bg: [["surface-secondary", 1], ["accent-blue-dim", 1]],
    before: { dark: 4.54, light: 4.05 },
  },
  {
    // ResearchArtifact.tsx — Recommendation body, was text-accent-green/80.
    name: "finding Recommendation body on the green wash",
    fg: "accent-green", bg: [["surface-secondary", 1], ["accent-green-dim", 0.5]],
    before: { dark: 4.45, light: 3.67 },
  },
  {
    // ResearchArtifact.tsx — Impact body, was text-accent-red/80.
    name: "finding Impact body on the red wash",
    fg: "accent-red", bg: [["surface-secondary", 1], ["accent-red-dim", 0.5]],
    before: { dark: 3.81, light: 4.14 },
  },
  {
    // App.tsx — the 9px artifact-count badge on the session strip, was opacity-70.
    name: "session-strip artifact count (9px)",
    fg: "text-secondary", bg: [["surface-primary", 1], ["surface-elevated", 1]],
    before: { dark: 4.77, light: 3.91 },
  },
];

describe("R2 — the six alpha-modifier contrast failures clear AA at settle, both themes", () => {
  it.each(CASES)("$name — dark (was $before.dark:1)", ({ fg, bg }) => {
    expect(measure("dark", fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CASES)("$name — light (was $before.light:1)", ({ fg, bg }) => {
    expect(measure("light", fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("the SELECTED session row's count inherits accent-blue and still clears AA (3.45 / 3.10 before)", () => {
    for (const theme of ["dark", "light"] as const) {
      expect(measure(theme, "accent-blue", [["surface-elevated", 1]])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("shows the fix is REAL — every case was genuinely under 4.5 with its old alpha", () => {
    // Re-derive the "before" numbers from the same tokens, so this file can't
    // quietly become a tautology if a token moves.
    const alphas = [0.7, 0.8, 0.9, 0.8, 0.8, 0.7];
    CASES.forEach((c, i) => {
      const fgToken = i === 0 ? "text-muted" : c.fg; // the label stepped UP a token
      const dark = measure("dark", fgToken, c.bg, alphas[i]!);
      const light = measure("light", fgToken, c.bg, alphas[i]!);
      expect(Math.min(dark, light), `${c.name} was supposed to be failing`).toBeLessThan(4.5);
    });
  });
});

describe("R2 — the alpha modifiers are gone from the six source sites", () => {
  /**
   * Comments are stripped before matching. The R2 fix comments QUOTE the class
   * they removed (that's the point of them — the next reader needs to know what
   * was there and why it went), so a naive substring search over the raw file
   * would match the explanation and never the code.
   */
  const read = (rel: string) =>
    fs.readFileSync(path.join(webSrc, rel), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("PreflightBlockLog no longer dims the proposal label with /70", () => {
    expect(read("components/PreflightBlockLog.tsx")).not.toContain("text-text-muted/70");
  });

  it("the external-review banner carries no opacity on its text spans", () => {
    const src = read("components/artifacts/ChangesetArtifact.tsx");
    expect(src).not.toContain('text-2xs opacity-80"');
    expect(src).not.toContain('className="opacity-90"');
  });

  it("finding Impact/Recommendation bodies use the solid accent tokens", () => {
    const src = read("components/artifacts/ResearchArtifact.tsx");
    expect(src).not.toContain("text-accent-red/80");
    expect(src).not.toContain("text-accent-green/80");
  });

  it("the session-strip count badge is not dimmed at 9px", () => {
    expect(read("App.tsx")).not.toContain('text-[9px] bg-surface-elevated px-1 py-0.5 rounded opacity-70');
  });
});
