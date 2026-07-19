/**
 * #166 — WCAG contrast lock on the SYNTAX palettes, extending the #149/#150
 * token-contrast approach to shiki's emitted token colors.
 *
 * Why: #187's light-theme axe scan — the first light scan ever to mount a
 * highlighted snippet — caught vitesse-light's #B07D48 at 3.27:1 on the light
 * surface-code. The audit behind this test found 16 failing light colors and 4
 * failing dark ones (dark punctuation #666666 was 3.20:1 — the dark scans were
 * only green because no seeded snippet ever emitted punctuation).
 *
 * How: this runs the REAL production pipeline — highlightLines() with the
 * shipped grammars, themes AND the #166 colorReplacements re-tint
 * (lib/syntax-palette.ts) — over snippets that exercise every token family in
 * all 13 preloaded languages, then asserts every emitted color >= 4.6 (the
 * house margin: 4.5 is the AA floor, 4.6 survives antialiasing/animation-frame
 * sampling) against the surface-code ground parsed from index.css. No
 * duplicated hex literals: if the replacement map, the themes, or surface-code
 * drift, this fails with the exact color/ratio/language list.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { highlightLines } from "../lib/highlighter";

// ---- surface-code grounds, parsed from index.css (mirrors token-contrast.test.ts)
const cssPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.css");
const css = fs.readFileSync(cssPath, "utf-8");
const darkBlock = css.slice(0, css.indexOf('[data-theme="light"] {'));
const lightBlock = css.slice(css.indexOf('[data-theme="light"] {'));

function surfaceCode(block: string, label: string): string {
  const m = block.match(/--color-surface-code:\s*(#[0-9a-fA-F]{6})\s*;/);
  if (!m?.[1]) throw new Error(`--color-surface-code not found in index.css ${label} block`);
  return m[1];
}

const DARK_SURFACE = surfaceCode(darkBlock, "dark");
const LIGHT_SURFACE = surfaceCode(lightBlock, "light");

// ---- WCAG 2.x math (the axe formula), plus alpha compositing: shiki emits
// 8-digit colors (vitesse mutes quotes/comments via alpha) and axe measures
// them blended over the background — so must we.
function blendOver(fg: string, bg: string): string {
  if (fg.length !== 9) return fg;
  const a = parseInt(fg.slice(7, 9), 16) / 255;
  const ch = (i: number) =>
    Math.round(a * parseInt(fg.slice(i, i + 2), 16) + (1 - a) * parseInt(bg.slice(i, i + 2), 16));
  return `#${[1, 3, 5].map((i) => ch(i).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(blendOver(fg, bg)), luminance(bg)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

// ---- snippets: one per preloaded grammar, written to emit every token family
// that language colors (strings, comments, keywords, numbers, functions,
// types, punctuation, regex, tags, diff markers, ...).
const SNIPPETS: Record<string, string> = {
  typescript: [
    "// a comment about caching",
    'import { readFile } from "node:fs/promises";',
    "export async function load(path: string): Promise<number> {",
    '  const raw = await readFile(path, "utf-8"); // trailing comment',
    "  const n: number = parseInt(raw, 10) + 0x1f * 3.14;",
    "  if (!raw) throw new Error(`empty: ${path}`);",
    "  return n ?? 42;",
    "}",
    "class Cache<T> extends Map<string, T> { readonly ttl = 1000; }",
    "const re = /ab+c/gi;",
  ].join("\n"),
  javascript: [
    "// comment",
    'const x = "string";',
    "let y = 'single' + `tpl ${x}`;",
    "function f(a, b = 2) { return a * b / 1.5; }",
    "export default { f, n: null, t: true, u: undefined };",
  ].join("\n"),
  json: '{ "name": "deeppairing", "version": 1.2, "flag": true, "nothing": null, "list": [1, "two"] }',
  css: [
    "/* comment */",
    '.card > .title:hover { color: #b07d48; margin: 1rem 0; content: "str"; }',
    "@media (max-width: 600px) { body { --tok: calc(100% - 2px); } }",
  ].join("\n"),
  html: '<!-- comment --><div class="card" id="x" data-n="1">Text &amp; more</div><script>const a = "s";</script>',
  python: [
    "# a comment",
    "import os",
    "def load(path: str) -> int:",
    '    """docstring"""',
    '    with open(path, "r") as f:',
    "        return int(f.read()) + 0x1f",
    "class Cache(dict):",
    "    TTL = 1000",
    'print(f"value {os.name!r}")',
  ].join("\n"),
  rust: [
    "// comment",
    "use std::collections::HashMap;",
    "fn main() -> Result<(), String> {",
    "    let mut m: HashMap<&str, i32> = HashMap::new();",
    '    m.insert("key", 0x1f + 3);',
    '    println!("{:?}", m); /* block */',
    "    Ok(())",
    "}",
  ].join("\n"),
  go: [
    "// comment",
    "package main",
    'import "fmt"',
    "func main() {",
    '    s := "string"',
    "    n := 0x1f + 3.14",
    '    fmt.Printf("%s %v\\n", s, n)',
    "}",
  ].join("\n"),
  bash: [
    "# comment",
    "set -euo pipefail",
    'NAME="world"',
    'echo "hello ${NAME}" | grep -c \'hello\' && exit 0',
  ].join("\n"),
  yaml: [
    "# comment",
    "name: deeppairing",
    "version: 1.2",
    "flag: true",
    "list:",
    '  - "quoted"',
    "  - plain",
    "nested: { key: null }",
  ].join("\n"),
  markdown: [
    "# Heading",
    "Some *em* and **strong** and `inline code`.",
    "- list item with [link](https://example.com)",
    "> quote",
    "",
    "```js",
    'const x = "s"; // c',
    "```",
  ].join("\n"),
  sql: [
    "-- comment",
    "SELECT id, name FROM users WHERE age > 21 AND name LIKE 'a%' ORDER BY id LIMIT 10;",
    'INSERT INTO t (a, b) VALUES (1, "x");',
  ].join("\n"),
  diff: [
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -1,3 +1,3 @@",
    " context line",
    '-const removed = "old";',
    '+const added = "new";',
  ].join("\n"),
};

const COLOR_RE = /color:(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)/g;

/** Every distinct color the pipeline emits for `theme`, with the langs using it. */
async function emittedColors(
  theme: "vitesse-dark" | "vitesse-light",
): Promise<Map<string, Set<string>>> {
  const colors = new Map<string, Set<string>>();
  for (const [lang, code] of Object.entries(SNIPPETS)) {
    const lines = await highlightLines(code, lang, theme);
    for (const line of lines) {
      for (const m of line.matchAll(COLOR_RE)) {
        const c = m[1]!.toLowerCase();
        const entry = colors.get(c) ?? new Set<string>();
        entry.add(lang);
        colors.set(c, entry);
      }
    }
  }
  if (colors.size === 0) throw new Error(`no colors emitted for ${theme} — hollow test`);
  return colors;
}

function failures(colors: Map<string, Set<string>>, surface: string): string[] {
  return [...colors.entries()]
    .map(([color, langs]) => ({ color, langs, ratio: contrast(color, surface) }))
    .filter((r) => r.ratio < 4.6)
    .sort((a, b) => a.ratio - b.ratio)
    .map((r) => `${r.color} = ${r.ratio.toFixed(2)}:1 on ${surface} [${[...r.langs].join(",")}]`);
}

describe("#166 — every emitted syntax token color keeps the 4.6 AA margin on surface-code", () => {
  // First call boots the wasm engine + 13 grammars — generous timeout for WSL /mnt/c.
  it("vitesse-light (as shipped, with the #166 re-tint) on light surface-code", { timeout: 60_000 }, async () => {
    const bad = failures(await emittedColors("vitesse-light"), LIGHT_SURFACE);
    expect(bad, `light syntax colors under 4.6:\n${bad.join("\n")}`).toEqual([]);
  });

  it("vitesse-dark (as shipped, with the #166 re-tint) on dark surface-code", { timeout: 60_000 }, async () => {
    const bad = failures(await emittedColors("vitesse-dark"), DARK_SURFACE);
    expect(bad, `dark syntax colors under 4.6:\n${bad.join("\n")}`).toEqual([]);
  });
});
