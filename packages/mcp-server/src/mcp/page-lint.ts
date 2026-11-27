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

/** CSS Syntax newline: LF, CR or FF (CRLF is a CR then an LF). */
function isCssNewline(c: number): boolean {
  return c === 10 || c === 13 || c === 12;
}

function isHexDigit(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

/** CSS name code point: letter, digit, `_`, `-` or non-ASCII. */
function isNameChar(c: number): boolean {
  return isAlpha(c) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c >= 0x80;
}

/** `\` at `i` starts a valid CSS escape (not `\` + newline, not at the end). */
function isEscapeAt(css: string, i: number): boolean {
  return css.charCodeAt(i) === 0x5c && i + 1 < css.length && !isCssNewline(css.charCodeAt(i + 1));
}

/** Consume the escape at `i` (its `\` included); returns [decoded, next index]. */
function consumeEscape(css: string, i: number): [string, number] {
  let j = i + 1;
  if (isHexDigit(css.charCodeAt(j))) {
    const hexStart = j;
    while (j < css.length && j - hexStart < 6 && isHexDigit(css.charCodeAt(j))) j++;
    const cp = parseInt(css.slice(hexStart, j), 16);
    if (css.charCodeAt(j) === 13 && css.charCodeAt(j + 1) === 10) j += 2;
    else if (isSpace(css.charCodeAt(j))) j++;
    const ok = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
    return [ok ? String.fromCodePoint(cp) : "�", j];
  }
  return [css[j] ?? "", j + 1];
}

/** Consume a run of name code points / escapes from `i`; returns [name, next]. */
function consumeName(css: string, i: number): [string, number] {
  let name = "";
  while (i < css.length) {
    const c = css.charCodeAt(i);
    if (isNameChar(c)) { name += css[i]; i++; }
    else if (isEscapeAt(css, i)) { const [d, j] = consumeEscape(css, i); name += d; i = j; }
    else break;
  }
  return [name, i];
}

/**
 * The tokens the lint cares about, from ONE forward CSS tokenizer (a subset
 * of CSS Syntax 3): comments, strings (ended by their quote, any CSS newline
 * as a bad-string, or the end of input; `\` + newline continues them), whole
 * ident / at-keyword / hash name runs (so `myurl(`, `--url(`, `#url(` are not
 * `url(`), and `url(` function tokens with their argument (quoted or not).
 * Every other code point is `other`. Linear: each character is visited once.
 */
type CssToken =
  | { kind: "comment"; start: number; end: number }
  | { kind: "string"; value: string }
  | { kind: "url"; value: string }
  | { kind: "at"; name: string }
  | { kind: "ident" | "hash"; name: string }
  | { kind: "space" }
  | { kind: "other" };

function consumeString(css: string, i: number): [string, number] {
  const quote = css.charCodeAt(i);
  let value = "";
  i++;
  while (i < css.length) {
    const d = css.charCodeAt(i);
    if (d === quote) return [value, i + 1];
    if (isCssNewline(d)) return [value, i]; // bad-string: the newline is not consumed
    if (d === 0x5c) {
      if (i + 1 >= css.length) return [value, i + 1];
      const e = css.charCodeAt(i + 1);
      if (e === 13 && css.charCodeAt(i + 2) === 10) { i += 3; continue; } // escaped CRLF
      if (isCssNewline(e)) { i += 2; continue; } // escaped newline continues the string
      const [dec, j] = consumeEscape(css, i);
      value += dec;
      i = j;
      continue;
    }
    value += css[i];
    i++;
  }
  return [value, i];
}

function scanCss(css: string, onToken: (t: CssToken) => void): void {
  const n = css.length;
  let i = 0;
  while (i < n) {
    const c = css.charCodeAt(i);
    if (c === 0x2f && css.charCodeAt(i + 1) === 0x2a) {
      const close = css.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2; // an unterminated comment runs to the end
      onToken({ kind: "comment", start: i, end });
      i = end;
    } else if (c === 0x22 || c === 0x27) {
      const [value, j] = consumeString(css, i);
      onToken({ kind: "string", value });
      i = j;
    } else if (isSpace(c)) {
      while (i < n && isSpace(css.charCodeAt(i))) i++;
      onToken({ kind: "space" });
    } else if (c === 0x40 /* @ */ || c === 0x23 /* # */) {
      const [name, j] = consumeName(css, i + 1);
      onToken(name ? { kind: c === 0x40 ? "at" : "hash", name: name.toLowerCase() } : { kind: "other" });
      i = name ? j : i + 1;
    } else if (isNameChar(c) || isEscapeAt(css, i)) {
      const [rawName, j] = consumeName(css, i);
      const name = rawName.toLowerCase();
      if (name === "url" && css.charCodeAt(j) === 0x28 /* ( */) {
        let k = j + 1;
        while (k < n && isSpace(css.charCodeAt(k))) k++;
        const q = css.charCodeAt(k);
        if (q === 0x22 || q === 0x27) {
          // url( "..." ): a function whose argument is the string token.
          const [value, m] = consumeString(css, k);
          onToken({ kind: "url", value });
          i = m;
        } else {
          // An unquoted url token runs to its `)` (escapes honoured).
          let value = "";
          while (k < n && css.charCodeAt(k) !== 0x29) {
            if (isEscapeAt(css, k)) { const [d, m] = consumeEscape(css, k); value += d; k = m; }
            else { value += css[k]; k++; }
          }
          onToken({ kind: "url", value: value.trim() });
          i = Math.min(k + 1, n);
        }
      } else {
        onToken({ kind: "ident", name });
        i = j;
      }
    } else if (c === 0x5c /* \ */) {
      i += 2; // `\` + newline (an invalid escape) is a delim; never opens anything
    } else {
      onToken({ kind: "other" });
      i++;
    }
  }
}

/**
 * CSS with every comment blanked out (one space each), from the same
 * tokenizer as the reference count: a `/*` inside a quoted string or a url()
 * is literal text, so `content:"/*"` cannot hide the rest of the stylesheet.
 */
export function stripCssComments(css: string): string {
  let out = "";
  let from = 0;
  scanCss(css, (t) => {
    if (t.kind !== "comment") return;
    out += css.slice(from, t.start) + " ";
    from = t.end;
  });
  return out + css.slice(from);
}

/**
 * Count external url(...) and @import targets in CSS text, by kind, from the
 * tokenizer: comments and quoted text that is not a url()/@import argument
 * never count. `@import url(...)` counts once, as an @import.
 */
export function externalCssRefs(css: string): { url: number; import: number } {
  const counts = { url: 0, import: 0 };
  let afterImport = false;
  scanCss(css, (t) => {
    if (t.kind === "space" || t.kind === "comment") return;
    if (afterImport) {
      afterImport = false;
      if (t.kind === "string" || t.kind === "url") {
        if (isExternal(t.value)) counts.import++;
        return;
      }
    }
    if (t.kind === "at" && t.name === "import") afterImport = true;
    else if (t.kind === "url" && isExternal(t.value)) counts.url++;
  });
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
