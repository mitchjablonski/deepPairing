/**
 * #714 gap 6 — present-time lint for agent-authored HTML pages.
 *
 * WARNINGS ONLY. Nothing here can refuse a page or touch the rejection gate:
 * present_page runs it after the page is stored and appends what it finds to
 * the result (text, structuredContent.warnings, and the CLI receipt).
 *
 * It checks the rules page-authoring.ts teaches:
 *  - external_asset: a resource the no-network sandbox will block (an
 *    http:, https: or protocol-relative URL on script/img/iframe/source/
 *    video/audio/embed/object/SVG image, a stylesheet <link>, or a CSS url()
 *    / @import). Plain navigation links (<a href>) never warn.
 *  - no_headings: no <h1>-<h6> anywhere.
 *  - no_section_ids: a page over PAGE_LINT_LONG_PAGE_BYTES whose <section>s
 *    and headings carry no id at all.
 *
 * Like page-text.ts it is NOT an HTML parser: no DOM exists on the server. It
 * is one forward scan with indexOf and fixed-length startsWith checks, no
 * regex over unbounded input, so its cost is linear in the page size even for
 * hostile input (thousands of unclosed <script> tags, unterminated quotes).
 */

/** Pages larger than this (UTF-8 bytes) should carry section ids. */
export const PAGE_LINT_LONG_PAGE_BYTES = 16 * 1024;
/** At most this many blocked URLs are quoted in a warning. */
export const PAGE_LINT_MAX_URLS = 5;
const MAX_URL_CHARS = 120;

export type PageLintCode = "external_asset" | "no_headings" | "no_section_ids";

export interface PageLintWarning {
  code: PageLintCode;
  message: string;
  /** external_asset: how many blocked references the page has. */
  count?: number;
  /** external_asset: the first few blocked URLs, as written. */
  urls?: string[];
}

/** Elements whose body is raw text: no tags inside it count. */
const RAW_TEXT = ["script", "style", "textarea", "xmp", "title", "template", "noembed", "noframes"] as const;

/** element -> attributes that load a resource the sandbox will block. */
const RESOURCE_ATTRS: Record<string, readonly string[]> = {
  script: ["src"],
  img: ["src", "srcset"],
  iframe: ["src"],
  frame: ["src"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  embed: ["src"],
  object: ["data"],
  input: ["src"],
  image: ["href", "xlink:href"], // SVG <image>
  use: ["href", "xlink:href"], // SVG <use> pointing at another document
};

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

function isAlpha(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
}

/** http:, https: or // at `at` in an already-lowercased string (after leading spaces). */
function externalAt(lower: string, at: number): boolean {
  let i = at;
  while (i < lower.length && isSpace(lower.charCodeAt(i))) i++;
  return lower.startsWith("http://", i) || lower.startsWith("https://", i) || lower.startsWith("//", i);
}

function isExternal(value: string): boolean {
  return externalAt(value.toLowerCase(), 0);
}

/** The external URLs in an srcset (comma-separated "url descriptor" candidates). */
function externalSrcset(value: string): string[] {
  const out: string[] = [];
  for (const candidate of value.split(",")) {
    const url = candidate.trim().split(/\s/, 1)[0] ?? "";
    if (url && isExternal(url)) out.push(url);
  }
  return out;
}

/**
 * External url(...) and @import targets in CSS text. Two indexOf walks, each
 * strictly forward, so linear in the CSS length.
 */
function externalCssUrls(css: string): string[] {
  const lower = css.toLowerCase();
  const out: string[] = [];
  const grab = (from: number): string => {
    let i = from;
    while (i < css.length && isSpace(css.charCodeAt(i))) i++;
    const q = css[i];
    if (q === "\"" || q === "'") i++;
    let j = i;
    while (j < css.length && j - i < MAX_URL_CHARS && !isSpace(css.charCodeAt(j)) && css[j] !== ")" && css[j] !== q && css[j] !== ";") j++;
    return css.slice(i, j);
  };
  for (const needle of ["url(", "@import"]) {
    let at = lower.indexOf(needle);
    while (at !== -1) {
      const start = at + needle.length;
      let i = start;
      while (i < lower.length && isSpace(lower.charCodeAt(i))) i++;
      if (lower[i] === "\"" || lower[i] === "'") i++;
      if (externalAt(lower, i)) out.push(grab(start));
      at = lower.indexOf(needle, start);
    }
  }
  return out;
}

interface Tag {
  name: string;
  attrs: Record<string, string>;
  /** Index just past the tag's closing `>` (or the end of input). */
  end: number;
}

/**
 * Read the start tag whose name begins at `at` (just after `<`). Attribute
 * values are read quote-aware, so `alt="a>b"` does not end the tag. Each
 * character is visited once.
 */
function readStartTag(html: string, lower: string, at: number): Tag {
  const n = html.length;
  let i = at;
  while (i < n && !isSpace(lower.charCodeAt(i)) && lower[i] !== "/" && lower[i] !== ">") i++;
  const name = lower.slice(at, i);
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  while (i < n) {
    while (i < n && (isSpace(lower.charCodeAt(i)) || lower[i] === "/")) i++;
    if (i >= n) break;
    if (lower[i] === ">") return { name, attrs, end: i + 1 };
    const nameStart = i;
    i++; // the first character is always part of the name (even `=`)
    while (i < n && !isSpace(lower.charCodeAt(i)) && lower[i] !== "/" && lower[i] !== ">" && lower[i] !== "=") i++;
    const attr = lower.slice(nameStart, i);
    let j = i;
    while (j < n && isSpace(lower.charCodeAt(j))) j++;
    let value = "";
    if (lower[j] === "=") {
      j++;
      while (j < n && isSpace(lower.charCodeAt(j))) j++;
      const q = html[j];
      if (q === "\"" || q === "'") {
        const close = html.indexOf(q, j + 1);
        value = html.slice(j + 1, close === -1 ? n : close);
        j = close === -1 ? n : close + 1;
      } else {
        const start = j;
        while (j < n && !isSpace(lower.charCodeAt(j)) && lower[j] !== ">") j++;
        value = html.slice(start, j);
      }
      i = j;
    }
    // A repeated attribute keeps its first value, as in a browser.
    if (!(attr in attrs)) attrs[attr] = value;
  }
  return { name, attrs, end: n };
}

/** Non-blocking warnings for a page. Never throws on any string input. */
export function lintPage(html: string): PageLintWarning[] {
  // ASCII-only lowercasing keeps indexes aligned with `html` (see page-text.ts).
  const lower = html.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  const n = html.length;
  // Memoized forward search for raw-text closers: `from` only grows, so a
  // cached hit at or past `from`, or a cached miss, stays valid. Thousands of
  // unclosed <script> tags therefore cost one scan, not one scan each.
  const lastAt = new Map<string, number>();
  const findClose = (tag: string, from: number): number => {
    const needle = `</${tag}`;
    const prev = lastAt.get(needle);
    if (prev !== undefined && (prev === -1 || prev >= from)) return prev;
    const at = lower.indexOf(needle, from);
    lastAt.set(needle, at);
    return at;
  };
  let commentEnd = -2; // memo for "-->" (same monotone argument)

  const blocked: string[] = [];
  let headings = 0;
  let sectionIds = 0;

  let i = 0;
  while (i < n) {
    const lt = lower.indexOf("<", i);
    if (lt === -1) break;
    if (lower.startsWith("<!--", lt)) {
      if (commentEnd !== -1 && commentEnd < lt + 4) commentEnd = lower.indexOf("-->", lt + 4);
      i = commentEnd === -1 ? n : commentEnd + 3;
      continue;
    }
    const next = lower.charCodeAt(lt + 1);
    if (next === 47 /* / */ || next === 33 /* ! */ || next === 63 /* ? */) {
      // End tag, doctype or processing instruction: nothing to check.
      const gt = lower.indexOf(">", lt + 2);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    if (!isAlpha(next)) {
      i = lt + 1;
      continue;
    }
    const tag = readStartTag(html, lower, lt + 1);
    i = tag.end;

    if (tag.name === "plaintext") break; // the rest is literal text
    if (HEADINGS.has(tag.name)) {
      headings++;
      if (tag.attrs.id?.trim()) sectionIds++;
    } else if (tag.name === "section" && tag.attrs.id?.trim()) {
      sectionIds++;
    }

    const resourceAttrs = RESOURCE_ATTRS[tag.name];
    if (resourceAttrs) {
      for (const attr of resourceAttrs) {
        const value = tag.attrs[attr];
        if (value === undefined) continue;
        if (attr === "srcset") for (const u of externalSrcset(value)) blocked.push(u);
        else if (isExternal(value)) blocked.push(value.trim());
      }
    }
    if (tag.name === "link" && tag.attrs.href !== undefined && isExternal(tag.attrs.href)) {
      const rel = ` ${(tag.attrs.rel ?? "").toLowerCase().replace(/\s+/g, " ")} `;
      if (rel.includes(" stylesheet ") || rel.includes(" preload ") || rel.includes(" modulepreload ") || rel.includes(" icon ")) {
        blocked.push(tag.attrs.href.trim());
      }
    }
    if (tag.attrs.style) for (const u of externalCssUrls(tag.attrs.style)) blocked.push(u);

    if ((RAW_TEXT as readonly string[]).includes(tag.name)) {
      const close = findClose(tag.name, tag.end);
      if (close === -1) continue; // unclosed: keep scanning after the start tag
      if (tag.name === "style") for (const u of externalCssUrls(html.slice(tag.end, close))) blocked.push(u);
      const gt = lower.indexOf(">", close);
      i = gt === -1 ? n : gt + 1;
    }
  }

  const warnings: PageLintWarning[] = [];
  if (blocked.length > 0) {
    const urls = [...new Set(blocked)].slice(0, PAGE_LINT_MAX_URLS).map((u) => (u.length > MAX_URL_CHARS ? `${u.slice(0, MAX_URL_CHARS)}…` : u));
    warnings.push({
      code: "external_asset",
      count: blocked.length,
      urls,
      message:
        `${blocked.length} external asset reference${blocked.length === 1 ? "" : "s"} will not load (the page has no network): ${urls.join(", ")}` +
        `${blocked.length > urls.length ? ", ..." : ""}. Inline the asset (data: URIs work) or drop it.`,
    });
  }
  if (headings === 0) {
    warnings.push({
      code: "no_headings",
      message: "The page has no headings (<h1>-<h6>). Add an <h1> and an <h2> per section so your pair can skim it.",
    });
  }
  if (sectionIds === 0 && Buffer.byteLength(html, "utf8") > PAGE_LINT_LONG_PAGE_BYTES) {
    warnings.push({
      code: "no_section_ids",
      message: `The page is over ${PAGE_LINT_LONG_PAGE_BYTES / 1024} KiB but no <section> or heading has an id. Wrap each part in <section id="..."> so your pair can navigate it and comments stay anchored across revisions.`,
    });
  }
  return warnings;
}

/** The warnings as a block for a tool result's text ("" when there are none). */
export function formatPageLintWarnings(warnings: readonly PageLintWarning[]): string {
  if (warnings.length === 0) return "";
  return `\n\nPage warnings (non-blocking; the page was presented):\n${warnings.map((w) => `- ${w.message}`).join("\n")}`;
}
