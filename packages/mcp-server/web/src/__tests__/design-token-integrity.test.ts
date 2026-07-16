/**
 * Design-token integrity — every `surface-*` / `accent-*` utility class used in
 * the web components must reference a CSS custom property that actually EXISTS
 * in index.css.
 *
 * Why this exists: `bg-surface-base` shipped in two modals (ProjectDecisionsModal,
 * SessionBrowserModal). `--color-surface-base` was never defined, so the class
 * resolved to `background-color: transparent` — the modal panels were see-through
 * over the blurred backdrop. It was invisible in dark mode (dark blur over a dark
 * UI reads as "dark-ish") and only showed up as translucent grey in light mode.
 * A dead token that renders transparent is a SILENT failure — nothing errors,
 * nothing warns; it just looks wrong. This test makes it loud.
 *
 * Scope: the `surface` and `accent` families only. Those prefixes are unambiguous
 * (Tailwind has no built-in `surface-*`/`accent-<name>` color of this shape), so
 * a match is always a semantic design token and the check is false-positive-free.
 * Dynamic classes (`bg-accent-${x}`) are skipped — this catches STATIC dead tokens.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, ".."); // web/src
const cssPath = path.join(webSrc, "index.css");

/** All `--color-surface-*` / `--color-accent-*` names defined in index.css. */
function definedTokens(): Set<string> {
  const css = fs.readFileSync(cssPath, "utf-8");
  const defined = new Set<string>();
  for (const m of css.matchAll(/--color-(surface|accent)-([a-z]+(?:-[a-z]+)*)\s*:/g)) {
    defined.add(`${m[1]}-${m[2]}`);
  }
  return defined;
}

/** Recursively collect .tsx/.ts files under web/src (excluding tests). */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// utility prefixes that take a color token
const USE_RE =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|shadow)-(surface|accent)-([a-z]+(?:-[a-z]+)*)/g;

describe("design-token integrity", () => {
  it("every surface-*/accent-* utility class references a defined --color-* token", () => {
    const defined = definedTokens();
    // sanity: the parser found the real tokens (guards against a regex that matches nothing)
    expect(defined.has("surface-elevated")).toBe(true);
    expect(defined.has("accent-blue")).toBe(true);

    const offenders: Array<{ token: string; file: string }> = [];
    for (const file of sourceFiles(webSrc)) {
      const text = fs.readFileSync(file, "utf-8");
      for (const m of text.matchAll(USE_RE)) {
        const token = `${m[1]}-${m[2]}`;
        if (!defined.has(token)) {
          offenders.push({ token, file: path.relative(webSrc, file) });
        }
      }
    }

    const detail = offenders.map((o) => `  ${o.token}  (${o.file})`).join("\n");
    expect(
      offenders.length,
      `Undefined design token(s) used in class names — these render TRANSPARENT (no --color-* definition in index.css):\n${detail}\n` +
        `Define the token in index.css (both themes) or switch to an existing one (e.g. surface-elevated).`,
    ).toBe(0);
  });
});
