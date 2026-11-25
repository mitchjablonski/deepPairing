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
 *    / @import, comments skipped). <noscript> content is skipped (the
 *    sanitizer drops it). Plain navigation links (<a href>) never warn. The
 *    warning names the tag and attribute, never the URL (it can carry
 *    credentials or signed parameters).
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

/** Advisory warning codes. These are NOT error codes (`ERROR_CODES`): a
 *  warning never refuses anything, so they live here as their own set. */
export const PAGE_LINT_CODES = {
  external_asset: "external_asset",
  no_headings: "no_headings",
  no_section_ids: "no_section_ids",
} as const;
export type PageLintCode = (typeof PAGE_LINT_CODES)[keyof typeof PAGE_LINT_CODES];

export interface PageLintWarning {
  code: PageLintCode;
  message: string;
  /** external_asset: how many blocked references the page has. */
  count?: number;
  /**
   * external_asset: where they are, grouped by tag and attribute (e.g.
   * "img src", "link href (stylesheet)", "CSS url() in <style>"). The URLs
   * themselves are never echoed: they can carry credentials or signed params.
   */
  sources?: Array<{ source: string; count: number }>;
}

/**
 * Elements whose body is skipped: raw text (no tags inside count), plus
 * <noscript>, whose content the companion's sanitizer drops before render.
 */
const SKIPPED_BODY = ["script", "style", "textarea", "xmp", "title", "template", "noembed", "noframes", "noscript"] as const;

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

/** How many srcset candidates ("url descriptor", comma-separated) are external. */
function externalSrcsetCount(value: string): number {
  let count = 0;
  for (const candidate of value.split(",")) {
    const url = candidate.trim().split(/\s/, 1)[0] ?? "";
    if (url && isExternal(url)) count++;
  }
  return count;
}

/** CSS with every comment blanked out, by one forward indexOf walk. */
function stripCssComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("/*", i);
    if (open === -1) { out += css.slice(i); break; }
    out += css.slice(i, open) + " ";
    const close = css.indexOf("*/", open + 2);
    if (close === -1) break; // an unterminated comment runs to the end
    i = close + 2;
  }
  return out;
}

/**
 * Count external url(...) and @import targets in CSS text, by kind. Comments
 * are skipped. `@import url(...)` counts once, as an @import. Each walk is a
 * strictly forward indexOf, so linear in the CSS length.
 */
export function externalCssRefs(rawCss: string): { url: number; import: number } {
  const lower = stripCssComments(rawCss).toLowerCase();
  const counts = { url: 0, import: 0 };
  /** Index of the URL after optional spaces and one optional quote. */
  const target = (from: number): number => {
    let i = from;
    while (i < lower.length && isSpace(lower.charCodeAt(i))) i++;
    if (lower[i] === "\"" || lower[i] === "'") i++;
    return i;
  };
  let at = lower.indexOf("@import");
  while (at !== -1) {
    let i = target(at + 7);
    if (lower.startsWith("url(", i)) i = target(i + 4);
    if (externalAt(lower, i)) counts.import++;
    at = lower.indexOf("@import", at + 7);
  }
  at = lower.indexOf("url(");
  while (at !== -1) {
    // Skip a url() that is the target of an @import (already counted).
    let k = at - 1;
    while (k >= 0 && isSpace(lower.charCodeAt(k))) k--;
    const isImportTarget = k >= 6 && lower.startsWith("@import", k - 6);
    if (!isImportTarget && externalAt(lower, target(at + 4))) counts.url++;
    at = lower.indexOf("url(", at + 4);
  }
  return counts;
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

  // source label -> count; insertion order is first-seen order.
  const blocked = new Map<string, number>();
  const add = (source: string, count = 1) => { if (count > 0) blocked.set(source, (blocked.get(source) ?? 0) + count); };
  const addCss = (css: string, where: string) => {
    const refs = externalCssRefs(css);
    add(`CSS url() in ${where}`, refs.url);
    add(`CSS @import in ${where}`, refs.import);
  };
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
        if (attr === "srcset") add(`${tag.name} srcset`, externalSrcsetCount(value));
        else if (isExternal(value)) add(`${tag.name} ${attr}`);
      }
    }
    if (tag.name === "link" && tag.attrs.href !== undefined && isExternal(tag.attrs.href)) {
      const rels = (tag.attrs.rel ?? "").toLowerCase().split(/\s+/);
      const kind = ["stylesheet", "modulepreload", "preload", "icon"].find((r) => rels.includes(r));
      if (kind) add(`link href (${kind})`);
    }
    if (tag.attrs.style) addCss(tag.attrs.style, "a style attribute");

    if ((SKIPPED_BODY as readonly string[]).includes(tag.name)) {
      const close = findClose(tag.name, tag.end);
      if (close === -1) continue; // unclosed: keep scanning after the start tag
      if (tag.name === "style") addCss(html.slice(tag.end, close), "<style>");
      const gt = lower.indexOf(">", close);
      i = gt === -1 ? n : gt + 1;
    }
  }

  const warnings: PageLintWarning[] = [];
  if (blocked.size > 0) {
    const sources = [...blocked].map(([source, count]) => ({ source, count }));
    const total = sources.reduce((sum, s) => sum + s.count, 0);
    warnings.push({
      code: PAGE_LINT_CODES.external_asset,
      count: total,
      sources,
      message:
        `${total} external asset reference${total === 1 ? "" : "s"} will not load (the page has no network): ` +
        `${sources.map((s) => `${s.source} x${s.count}`).join(", ")}. ` +
        "Inline images and fonts as data: URIs and styles and scripts as inline <style>/<script>; video, audio, iframes and objects won't load at all.",
    });
  }
  if (headings === 0) {
    warnings.push({
      code: PAGE_LINT_CODES.no_headings,
      message: "The page has no headings (<h1>-<h6>). Add an <h1> and an <h2> per section so your pair can skim it.",
    });
  }
  if (sectionIds === 0 && Buffer.byteLength(html, "utf8") > PAGE_LINT_LONG_PAGE_BYTES) {
    warnings.push({
      code: PAGE_LINT_CODES.no_section_ids,
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

/** Lint a page without ever throwing (a lint bug must not cost a tool result). */
export function safeLintPage(html: unknown): PageLintWarning[] {
  if (typeof html !== "string") return [];
  try { return lintPage(html); } catch { return []; }
}
