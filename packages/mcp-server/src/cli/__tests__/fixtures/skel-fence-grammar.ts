/**
 * Vendored fence-grammar cases from skeleton-skills (#683).
 *
 *   source: github.com/mitchjablonski/skeleton-skills
 *   commit: 0b0954beca77a49d9091f97f60722352d4230bb8 (origin/main)
 *   date:   2026-11-20
 *   from:   test/skel.test.mjs, test/markers-cost.test.mjs and
 *           test/strict-capture-view.test.mjs (marker and escape cases only)
 *
 * Translated to data: each case is input text plus the expected fences or
 * error, or a body plus the escape verdict. Run by
 * src/cli/__tests__/skel-fence-grammar.test.ts through scanSkeletonText and
 * bodyEscapesFence. When re-syncing, update the commit and date above.
 */

export type FenceTuple = [id: string, title: string, openLine: number, closeLine: number, status: "todo" | "filled"];

export interface MarkerCase {
  name: string;
  text: string;
  /** Expected fences, or the error the scan must throw. */
  fences?: FenceTuple[];
  error?: RegExp;
}

export interface EscapeCase {
  name: string;
  body: string;
  marker: string;
  file: string;
  /** null = stays in its block; a RegExp = escapes, with that reason; "escape" = escapes, any reason. */
  expect: null | RegExp | "escape";
}

const SRC = `import { Point } from "./types";

export function smooth(raw: Point[]): Point[] {
  // SKEL[1] drop near-duplicate points
  throw new Error("SKEL_TODO");
  // /SKEL[1]
}

export function interpolate(a: Point, b: Point): Point[] {
  // SKEL[2] catmull-rom between a and b
  throw new Error("SKEL_TODO");
  // /SKEL[2]
}
`;

/** strict-capture-view.test.mjs: every comment style, LF and CRLF. */
const STYLES: Array<[open: string, close: string]> = [
  ["// ", ""], ["# ", ""], ["-- ", ""], ["; ", ""], ["/* ", " */"], ["/*", "*/"], ["<!-- ", " -->"], ["{/* ", " */}"], ["\t; ", ""],
];

export const MARKER_CASES: MarkerCase[] = [
  // skel.test.mjs "scanText finds fences with lines, titles, and status"
  {
    name: "two todo fences with titles and lines",
    text: SRC,
    fences: [
      ["1", "drop near-duplicate points", 4, 6, "todo"],
      ["2", "catmull-rom between a and b", 10, 12, "todo"],
    ],
  },
  // "scanText handles hash and block comment prefixes"
  {
    name: "hash prefix, todo",
    text: "def f():\n    # SKEL[a] do it\n    raise NotImplementedError('SKEL_TODO')\n    # /SKEL[a]\n",
    fences: [["a", "do it", 2, 4, "todo"]],
  },
  {
    name: "html block comment prefix and terminator, filled",
    text: "<div>\n<!-- SKEL[3] markup -->\n<p>hi</p>\n<!-- /SKEL[3] -->\n</div>\n",
    fences: [["3", "markup", 2, 4, "filled"]],
  },
  // "scanText rejects unclosed, mismatched, and nested fences"
  { name: "unclosed", text: "// SKEL[1] x\n", error: /<text>:1: SKEL\[1\] is never closed/ },
  { name: "mismatched close", text: "// SKEL[1] x\n// /SKEL[2]\n", error: /<text>:2: \/SKEL\[2\] closes SKEL\[1\] \(opened line 1\)/ },
  { name: "nested", text: "// SKEL[1] x\n// SKEL[2] y\n// /SKEL[2]\n// /SKEL[1]\n", error: /<text>:2: SKEL\[2\] opened inside SKEL\[1\] — fences don't nest/ },
  { name: "close with nothing open", text: "// /SKEL[1]\n", error: /<text>:1: \/SKEL\[1\] closes nothing/ },
  // "toSteps groups multi-fence steps" inputs: the SKEL_TODO status rule and empty titles
  { name: "SKEL_TODO anywhere in the body is todo", text: "// SKEL[10] ten\nSKEL_TODO\n// /SKEL[10]\n", fences: [["10", "ten", 1, 3, "todo"]] },
  { name: "a body without SKEL_TODO is filled", text: "// SKEL[2] two\ndone\n// /SKEL[2]\n", fences: [["2", "two", 1, 3, "filled"]] },
  { name: "a marker with no title", text: "// SKEL[2]\nSKEL_TODO\n// /SKEL[2]\n", fences: [["2", "", 1, 3, "todo"]] },
  // markers-cost.test.mjs: title trimming outside the regex
  { name: "a line separator in the title is not a marker", text: "// SKEL[1] a\u2028b\nbody\n// /SKEL[1]\n", error: /closes nothing/ },
  { name: "a paragraph separator in the title is not a marker", text: "// SKEL[1] a\u2029b\nbody\n// /SKEL[1]\n", error: /closes nothing/ },
  { name: "a close marker with trailing text is not a close", text: "// /SKEL[1]" + " ".repeat(1000) + "x", fences: [] },
  // strict-capture-view.test.mjs "host-valid fenced files in every comment style and line ending"
  ...STYLES.flatMap(([o, c]) =>
    (["\n", "\r\n"] as const).map((eol): MarkerCase => ({
      name: `style ${JSON.stringify(o)}…${JSON.stringify(c)} ${eol === "\n" ? "LF" : "CRLF"}`,
      text: `x${eol}${o}SKEL[a.1] title ${c}${eol}body${eol}${o}/SKEL[a.1]${c}${eol}tail`,
      fences: [["a.1", "title", 2, 4, "filled"]],
    })),
  ),
  // "host-valid long fence ids and titles"
  {
    name: "long id and title",
    text: `// SKEL[a${"b".repeat(299)}] ${"t".repeat(5000)}\nbody\n// /SKEL[a${"b".repeat(299)}]\n`,
    fences: [[`a${"b".repeat(299)}`, "t".repeat(5000), 1, 3, "filled"]],
  },
];

/**
 * markers-cost.test.mjs "linear marker parser preserves legacy … grammar":
 * the cross product of these, checked against the legacy one-regex parser.
 */
export const LEGACY_GRAMMAR = {
  comments: ["//", "#", "--", ";", "/*", "<!--", "{/*"],
  chunks: ["", "x", " ", "\t", "\r", "\u2028", "\uFEFF", "*/", "*/}", "-->", " }", "x  x"],
  terminators: ["", " ", "*/", "*/}", "-->"],
  id: "a.1-b",
};

/** markers-cost.test.mjs "long whitespace titles … finish in a bounded child". */
export const LONG_WHITESPACE_SPACES = 800_000;

export const ESCAPE_CASES: EscapeCase[] = [
  // skel.test.mjs "bodyEscapesFence catches the Python dedent and a bracket left open"
  { name: "python dedent", body: "    return 1\ndef injected():\n    return 9", marker: "    # SKEL[1] x", file: "f.py", expect: /indented outside/ },
  { name: "python apostrophe in a comment", body: "    if x:\n        return 1  # don't", marker: "    # SKEL[1] x", file: "f.py", expect: null },
  { name: "bracket left open", body: "  if (x) {", marker: "  // SKEL[1] x", file: "a.ts", expect: /bracket open/ },
  // "N8: the containment heuristic accepts ordinary code in several languages"
  { name: "python floor division", body: "    total = max(1, n // size)", marker: "    # SKEL[1] x", file: "f.py", expect: null },
  { name: "python triple-quoted string", body: '    q = """\nSELECT (a\n  FROM t\n"""', marker: "    # SKEL[1] x", file: "f.py", expect: null },
  { name: "shell case patterns", body: "  case $1 in\n    a) echo a;;\n  esac", marker: "  # SKEL[1] x", file: "f.sh", expect: null },
  { name: "rust lifetimes", body: "    fn h<'a>(x: &'a str) -> &'a str { x }", marker: "    // SKEL[1] x", file: "f.rs", expect: null },
  { name: "C preprocessor lines", body: "#ifdef DEBUG\n  log();\n#endif", marker: "  // SKEL[1] x", file: "f.c", expect: null },
  { name: "block comment with a brace", body: "  /* } not a brace */ return 1;", marker: "  // SKEL[1] x", file: "a.ts", expect: null },
  // "N8" deny-mode body (via the gate in skel; the heuristic directly here)
  { name: "closes the function on one line", body: "return raw; } export function x() { return [];", marker: "  // SKEL[1] x", file: "a.ts", expect: "escape" },
  // "R5: a regex containing /* doesn't open a comment that hides an escape"
  { name: "regex containing /*", body: "  const r = /\\/*/;\n  return 1;\n}\nexport function evil() {", marker: "  // SKEL[1] x", file: "a.ts", expect: "escape" },
  // "PR#1 #10: ordinary fills don't trip the containment heuristic"
  { name: "regex with an escaped paren", body: '  s = s.replace(/\\(/g, "");', marker: "  // SKEL[1] x", file: "a.ts", expect: null },
  { name: "regex with a negated class holding ]", body: "  const m = /[^\\]]+/.exec(s);", marker: "  // SKEL[1] x", file: "a.ts", expect: null },
  { name: "JSX text apostrophe", body: "  return <p>Don't {items.map((i) => (<li>{i}</li>))}</p>;", marker: "  // SKEL[1] x", file: "a.tsx", expect: null },
  { name: "prose list", body: "1) first item\n2) second", marker: "  // SKEL[1] x", file: "a.md", expect: null },
  { name: "closes the function mid-line", body: "  return 2; } export function evil() { return 1;", marker: "  // SKEL[1] x", file: "a.ts", expect: "escape" },
  // "issue #6 N1: a closed string is an operand"
  ...['"', "'", "`"].map((q): EscapeCase => ({
    name: `${q}s${q} / 2 divides, so the } after it counts`,
    body: `  x = ${q}s${q} / 2; } function evil() { y = 3 / 1;`,
    marker: "  // SKEL[1] x",
    file: "a.ts",
    expect: "escape",
  })),
  { name: "chained division", body: "  const r = a / b / c;", marker: "  // SKEL[1] x", file: "a.ts", expect: null },
  { name: "division after strings", body: '  const half = "10" / 2 + `4` / 2;', marker: "  // SKEL[1] x", file: "a.ts", expect: null },
  { name: "regex holding }", body: '  const re = /}/g; return s.replace(re, "");', marker: "  // SKEL[1] x", file: "a.ts", expect: null },
  { name: "regex holding { after (", body: '  if (/^{/.test(s)) return "a" + s.split(/,/).length;', marker: "  // SKEL[1] x", file: "a.ts", expect: null },
  { name: "division inside an arrow", body: "  return x.map((v) => v / 2);", marker: "  // SKEL[1] x", file: "a.ts", expect: null },
  { name: "regex class holding ) and }", body: '  const s = f("a", /[)}]/);', marker: "  // SKEL[1] x", file: "a.ts", expect: null },
  // deepPairing #683: the false positives the issue names
  { name: "#683: a lone Rust lifetime", body: "    fn first<'a>(v: &'a [u8]) -> &'a u8 { &v[0] }", marker: "    // SKEL[1] x", file: "f.rs", expect: null },
  { name: "#683: a /[)]/ regex", body: "  const parts = s.split(/[)]/);", marker: "  // SKEL[1] x", file: "a.ts", expect: null },
];
