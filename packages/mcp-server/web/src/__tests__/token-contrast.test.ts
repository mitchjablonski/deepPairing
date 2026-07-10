/**
 * #149 — WCAG contrast lock on the accent-on-dim pill pairings, computed from
 * the REAL token values in index.css (no browser needed).
 *
 * Why: CI's decisions-view axe scan flickered with a phantom "serious"
 * color-contrast at ~4.45. Root cause: the F1 re-tint landed blue-on-blue-dim
 * at 4.51 and red-on-red-dim at 4.60 — AA, but with ~zero margin — and the
 * artifact entrance fade (ArtifactPanel's framer-motion opacity 0→1) lets axe
 * sample a pill a frame before opacity settles, blending the text toward the
 * fill and dipping the measured ratio below the 4.5 threshold. The fix is
 * MARGIN in the tokens themselves (both -dim fills darkened), never a
 * disabled axe rule. This test fails the moment any accent-on-its-own-dim
 * pair drops back under 4.6, without needing a browser.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cssPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.css");
const css = fs.readFileSync(cssPath, "utf-8");
// Scope to the dark @theme block — the light block re-declares several tokens.
// Match the light block's SELECTOR (`[data-theme="light"] {`), not the bare
// attribute string — the header comment mentions it too.
const darkBlock = css.slice(0, css.indexOf('[data-theme="light"] {'));
const lightBlock = css.slice(css.indexOf('[data-theme="light"] {'));

function token(name: string): string {
  const m = darkBlock.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!m?.[1]) throw new Error(`token --color-${name} not found (or not a 6-digit hex) in index.css dark block`);
  return m[1];
}

/**
 * #150 — resolve a token as the LIGHT theme sees it: the [data-theme="light"]
 * override if declared, else CSS-custom-property inheritance falls back to the
 * dark @theme value. This fallback is exactly the mechanism that caused the
 * bug (dark accent fgs leaking onto pale light dims), so the resolver must
 * model it rather than require every token in the light block.
 */
function lightToken(name: string): string {
  const m = lightBlock.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  return m?.[1] ?? token(name);
}

/** WCAG 2.x relative luminance + contrast ratio (the axe formula). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("#149 — accent text on its own -dim pill fill keeps real AA margin (dark theme)", () => {
  // The two pairs the flake hit (4.51 / 4.60 pre-fix — no margin):
  it("accent-blue on accent-blue-dim ≥ 4.6", () => {
    expect(contrast(token("accent-blue"), token("accent-blue-dim"))).toBeGreaterThanOrEqual(4.6);
  });

  it("accent-red on accent-red-dim ≥ 4.6", () => {
    expect(contrast(token("accent-red"), token("accent-red-dim"))).toBeGreaterThanOrEqual(4.6);
  });

  // The rest of the family already has margin; lock the invariant so a future
  // re-tint of ANY dim fill can't reintroduce a borderline pill.
  it.each([
    ["accent-green", "accent-green-dim"],
    ["accent-amber", "accent-amber-dim"],
    ["accent-violet", "accent-violet-dim"],
    ["accent-cyan", "accent-cyan-dim"],
  ])("%s on %s ≥ 4.6", (fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.6);
  });
});

describe("#150 — LIGHT theme accent text on its own -dim pill keeps real AA margin", () => {
  // Pre-fix, five of six pairs failed hard (red 2.85, amber 2.08, green 2.31,
  // violet 2.35, cyan 1.61): the light block re-declared the -dim fills but
  // inherited DARK's accent foregrounds. Invisible to the axe e2e, which only
  // scanned the dark theme (now covered by a11y.e2e.ts's light-theme scan).
  // Same 4.6 floor as the dark section — margin over 4.5 so animation-frame
  // sampling can't dip a pair under AA.
  it.each([
    ["accent-blue", "accent-blue-dim"],
    ["accent-red", "accent-red-dim"],
    ["accent-amber", "accent-amber-dim"],
    ["accent-green", "accent-green-dim"],
    ["accent-violet", "accent-violet-dim"],
    ["accent-cyan", "accent-cyan-dim"],
  ])("%s on %s ≥ 4.6 (light)", (fg, bg) => {
    expect(contrast(lightToken(fg), lightToken(bg))).toBeGreaterThanOrEqual(4.6);
  });

  // The same accent fgs also render as text on the plain light surfaces
  // (links, badges outside pills). Lock AA there too — a future lightening of
  // a light accent could pass the pale dim yet fail on white.
  it.each([
    ["accent-blue"],
    ["accent-red"],
    ["accent-amber"],
    ["accent-green"],
    ["accent-violet"],
    ["accent-cyan"],
  ])("%s on light surface-primary ≥ 4.5", (fg) => {
    expect(contrast(lightToken(fg), lightToken("surface-primary"))).toBeGreaterThanOrEqual(4.5);
  });
});
