/**
 * #714 gap 11 — Mermaid blocks in an agent-authored page, rendered PARENT-side.
 *
 * A page renders in an opaque-origin sandbox with a no-network CSP, and agent
 * scripts only run after the human clicks Run, so the page can't load Mermaid
 * itself: a `<pre class="mermaid">` would show as raw source. The companion
 * already bundles Mermaid, so before the frame's srcdoc is built the parent:
 *
 *  1) parses the agent HTML with DOMParser (never executes anything) and finds
 *     `pre.mermaid`, `div.mermaid` and `code.language-mermaid` blocks;
 *  2) renders each block's text to SVG with the bundled Mermaid inside an
 *     ISOLATED renderer frame (mermaidFrameRenderer.ts: a hidden opaque-origin
 *     sandbox with a no-network CSP, `securityLevel: "strict"`, htmlLabels off,
 *     a hardened `secure` list) — never in the companion's own document;
 *  3) runs that SVG through a STRICT allowlist sanitizer (below) — no script,
 *     no `on*`, no external href / url(), foreignObject label HTML reduced to
 *     a few text-formatting tags;
 *  4) puts the sanitized SVG in place of the block, keeping Mermaid's node
 *     `id` / `class="node"` (and `data-id`, which Mermaid 11 sets on edges)
 *     so the annotator's diagram-node anchor (`g.node`, `*-flowchart-<id>-N`)
 *     works.
 *
 * A block that fails, is too large, is over the per-page count, or times out
 * keeps its source with a small inline note. A timeout aborts the request,
 * which destroys the renderer frame, and is never cached. The renderer is injectable so
 * the pipeline is testable without layout APIs (happy-dom has no getBBox);
 * real rendering is covered by e2e.
 *
 * The frame still re-sanitizes the whole page before Run (pageSanitize.ts)
 * and its nonce CSP still applies, so this is one more layer, not the only one.
 */
import { PAGE_SANITIZE_DROP_TAGS } from "@deeppairing/shared";
import { isDangerousUrl } from "./pageSanitize";
import {
  RendererColdError, RendererExhaustedError, RendererUnavailableError, sharedMermaidFrameRenderer,
} from "./mermaidFrameRenderer";

export type PageTheme = "light" | "dark";

/** Renders Mermaid source to an SVG string. Rejects on a parse/render error.
 *  `signal` aborts the request (the frame renderer destroys its frame). A
 *  renderer with `reportsStart` calls `onStart` once the work actually begins
 *  (its frame is warm); the per-diagram timeout starts there, so a cold load
 *  isn't charged to the diagram. The page budget always runs from the call. */
export type MermaidRenderer = ((
  id: string, source: string, theme: PageTheme, signal?: AbortSignal, onStart?: () => void,
) => Promise<string>) & { reportsStart?: boolean };

/** At most this many diagrams are rendered per page. */
export const PAGE_MERMAID_MAX_DIAGRAMS = 20;
/** A block's source longer than this is not rendered (Mermaid's own default
 *  cap is 50k; ours is tighter because a page can carry many). */
export const PAGE_MERMAID_MAX_SOURCE_CHARS = 20_000;
/** A rendered SVG larger than this is discarded. */
export const PAGE_MERMAID_MAX_SVG_CHARS = 1024 * 1024;
/** Wait at most this long for one diagram. */
export const PAGE_MERMAID_TIMEOUT_MS = 5_000;
/** And at most this long for the whole page. */
export const PAGE_MERMAID_TOTAL_TIMEOUT_MS = 15_000;

export interface PageMermaidOptions {
  theme: PageTheme;
  renderer?: MermaidRenderer;
  maxDiagrams?: number;
  maxSourceChars?: number;
  maxSvgChars?: number;
  timeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface PageMermaidResult {
  /** The page with rendered diagrams in place (unchanged if no blocks). */
  html: string;
  rendered: number;
  /** Blocks left as source, with a note (failed, over a cap, or timed out). */
  fallback: number;
  /** Of those, how many timed out (a result with any is never cached). */
  timedOut: number;
  /** Of those, how many found no renderer on this host (never cached). */
  unavailable?: number;
}

const BLOCK_SEL = "pre.mermaid, div.mermaid, code.language-mermaid";

/** Cheap gate before any parsing: a page without the word has no blocks. */
export function pageHasMermaid(html: string): boolean {
  return /mermaid/i.test(html);
}

/** True only when the page has an actual Mermaid block (a page that merely
 *  mentions Mermaid never shows the "rendering" placeholder). Parses only
 *  after the cheap word gate; never executes anything. */
export function pageHasMermaidBlocks(html: string): boolean {
  if (!pageHasMermaid(html) || typeof DOMParser === "undefined") return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return findMermaidBlocks(doc).some((b) => (b.textContent ?? "").trim() !== "");
}

// ---------------------------------------------------------------------------
// SVG sanitizer
// ---------------------------------------------------------------------------

/** SVG elements kept (lowercased localName). Anything else is dropped with its
 *  subtree, except `<a>`, which is unwrapped so its label survives. */
const SVG_ALLOW: ReadonlySet<string> = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textpath",
  "defs", "marker", "style", "title", "desc", "lineargradient", "radialgradient", "stop", "clippath", "mask",
  "pattern", "symbol", "use", "foreignobject", "switch",
  "filter", "feblend", "fecolormatrix", "fecomposite", "fedropshadow", "feflood", "fegaussianblur", "femerge",
  "femergenode", "feoffset",
]);

/** HTML kept inside a foreignObject (Mermaid's htmlLabels). Other elements are
 *  unwrapped (text kept), except those in HTML_DROP, which go with their
 *  content. */
const HTML_ALLOW: ReadonlySet<string> = new Set([
  "div", "span", "p", "br", "b", "strong", "i", "em", "u", "s", "code", "sub", "sup", "small", "mark", "pre",
  "ul", "ol", "li",
]);
const HTML_DROP: ReadonlySet<string> = new Set([
  ...PAGE_SANITIZE_DROP_TAGS, "style", "link", "meta", "title", "img", "picture", "source", "video", "audio",
  "track", "svg", "math", "form", "input", "button", "textarea", "select", "option", "canvas",
]);
const HTML_ATTR_ALLOW: ReadonlySet<string> = new Set(["class", "dir", "xmlns", "style"]);

/** Attributes never kept on an SVG element, whatever their value. */
const SVG_ATTR_DROP: ReadonlySet<string> = new Set(["src", "srcdoc", "action", "formaction", "xml:base", "background"]);

/** True if any `url(` in the text points anywhere but a same-document `#id`.
 *  One forward indexOf walk. */
function hasNonLocalUrl(lower: string): boolean {
  let at = lower.indexOf("url(");
  while (at !== -1) {
    let j = at + 4;
    while (j < lower.length && /\s/.test(lower[j]!)) j++;
    if (lower[j] === "\"" || lower[j] === "'") j++;
    while (j < lower.length && /\s/.test(lower[j]!)) j++;
    if (lower[j] !== "#") return true;
    at = lower.indexOf("url(", at + 4);
  }
  return false;
}

/** CSS (a `<style>` body or a `style=` value) with no way to load or run
 *  anything, or null. Any backslash rejects it: a CSS escape like `u\72l(`
 *  could otherwise hide a url( from the checks (Mermaid's own CSS has none). */
export function cleanSvgCss(css: string): string | null {
  if (css.includes("\\")) return null;
  const lower = css.toLowerCase();
  if (/@import|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|image-set\s*\(|image\s*\(|cross-fade\s*\(|\bsrc\s*\(|<\//.test(lower)) return null;
  if (hasNonLocalUrl(lower)) return null;
  return css;
}

function isHrefName(name: string): boolean {
  return name === "href" || name.endsWith(":href");
}

function scrubSvgAttrs(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    let keep = true;
    if (name.startsWith("on") || SVG_ATTR_DROP.has(name)) keep = false;
    else if (isHrefName(name)) keep = value.trim().startsWith("#");
    else if (name === "style") {
      const css = cleanSvgCss(value);
      if (css === null) keep = false;
      else if (css !== value) el.setAttribute(attr.name, css);
    } else if (isDangerousUrl(value)) keep = false;
    else if (value.toLowerCase().includes("url(") && hasNonLocalUrl(value.toLowerCase())) keep = false;
    if (!keep) el.removeAttribute(attr.name);
  }
}

function scrubHtmlAttrs(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (!HTML_ATTR_ALLOW.has(name)) { el.removeAttribute(attr.name); continue; }
    if (name === "style") {
      const css = cleanSvgCss(attr.value);
      if (css === null) el.removeAttribute(attr.name);
      else if (css !== attr.value) el.setAttribute(attr.name, css);
    }
  }
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

/** Walk an `<svg>` subtree in place, applying the allowlist. `inHtml` is true
 *  inside a foreignObject. Iterative so a deep hostile tree can't blow the
 *  stack. Exported for tests. */
export function sanitizeSvgTree(root: Element): void {
  const stack: Array<{ el: Element; inHtml: boolean }> = [{ el: root, inHtml: false }];
  while (stack.length) {
    const { el, inHtml } = stack.pop()!;
    const tag = el.localName.toLowerCase();
    if (el !== root) {
      if (inHtml) {
        if (HTML_DROP.has(tag)) { el.remove(); continue; }
        if (!HTML_ALLOW.has(tag)) {
          const kids = Array.from(el.children);
          unwrap(el);
          for (const k of kids) stack.push({ el: k, inHtml });
          continue;
        }
        scrubHtmlAttrs(el);
      } else {
        if (tag === "a") {
          const kids = Array.from(el.children);
          unwrap(el);
          for (const k of kids) stack.push({ el: k, inHtml });
          continue;
        }
        if (!SVG_ALLOW.has(tag)) { el.remove(); continue; }
        if (tag === "style") {
          const css = cleanSvgCss(el.textContent ?? "");
          if (css === null) { el.remove(); continue; }
          el.textContent = css;
          for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
          continue;
        }
        scrubSvgAttrs(el);
      }
    } else {
      scrubSvgAttrs(el);
    }
    const childInHtml = inHtml || tag === "foreignobject";
    for (const k of Array.from(el.children)) stack.push({ el: k, inHtml: childInHtml });
  }
}

/**
 * Parse an SVG string and return the sanitized `<svg>` element (owned by a
 * throwaway document; import it before inserting), or null when the input is
 * not a single SVG root.
 */
export function sanitizeMermaidSvg(svg: string): SVGSVGElement | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${svg}</body></html>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root || root.localName.toLowerCase() !== "svg") return null;
  sanitizeSvgTree(root);
  return root as unknown as SVGSVGElement;
}

// ---------------------------------------------------------------------------
// Block discovery + injection
// ---------------------------------------------------------------------------

/** The element to replace for each block, in document order, outermost only.
 *  A `code.language-mermaid` that is the only element in a `<pre>` replaces
 *  the `<pre>`. */
export function findMermaidBlocks(doc: Document): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(doc.querySelectorAll(BLOCK_SEL))) {
    let target: Element = el;
    const parent = el.parentElement;
    if (el.localName === "code" && parent?.localName === "pre" && parent.children.length === 1 &&
      (parent.textContent ?? "").trim() === (el.textContent ?? "").trim()) {
      target = parent;
    }
    if (out.some((o) => o === target || o.contains(target))) continue;
    out.push(target);
  }
  return out;
}

/** Notes shown under a block left as source. */
export const PAGE_MERMAID_NOTES = {
  failed: "Diagram couldn't be rendered; showing its source.",
  tooLarge: "Diagram couldn't be rendered: its source is too large; showing it as text.",
  tooMany: "Diagram couldn't be rendered: this page has more diagrams than the companion renders; showing its source.",
  timedOut: "Diagram took too long to render; showing its source. Reopen the page to retry.",
  unavailable: "Diagrams render in the browser companion; showing source here.",
  exhausted: "Diagrams couldn't load in this tab; reload to retry.",
} as const;

function noteAfter(doc: Document, block: Element, text: string): void {
  const note = doc.createElement("div");
  note.setAttribute("data-dp-mermaid-note", "");
  note.setAttribute("role", "note");
  note.setAttribute("style", "font:12px/1.4 system-ui,sans-serif;color:#92400e;margin:2px 0 8px");
  note.textContent = text;
  block.after(note);
}

function wrapperStyle(theme: PageTheme): string {
  // The frame body is white; a dark-themed diagram gets its own dark panel so
  // its light strokes and text stay legible.
  return theme === "dark"
    ? "margin:8px 0;padding:8px;border-radius:6px;background:#1f2020;overflow-x:auto"
    : "margin:8px 0;padding:8px 0;overflow-x:auto";
}

class Timeout extends Error {}

/** Run one render with a deadline. On timeout the request is ABORTED (the
 *  frame renderer destroys its frame, killing the work), not just abandoned.
 *  `ms` (per diagram) starts when the renderer reports the work started;
 *  `budgetMs` (what is left of the page budget) runs from the call. */
function renderWithTimeout(
  renderer: MermaidRenderer, id: string, source: string, theme: PageTheme, ms: number, budgetMs: number,
): Promise<string> {
  const ctl = new AbortController();
  return new Promise<string>((resolve, reject) => {
    let perDiagram: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      reject(new Timeout());
      ctl.abort();
    };
    const budget = setTimeout(fire, budgetMs);
    const start = () => { if (perDiagram === undefined) perDiagram = setTimeout(fire, ms); };
    const clear = () => { clearTimeout(budget); if (perDiagram !== undefined) clearTimeout(perDiagram); };
    if (!renderer.reportsStart) start();
    Promise.resolve()
      .then(() => renderer(id, source, theme, ctl.signal, start))
      .then((v) => { clear(); resolve(v); }, (e) => { clear(); reject(e); });
  });
}

/** Deterministic per page (index order) so node ids — and the annotator's
 *  locators — stay the same across reloads and theme changes. */
export function pageMermaidId(index: number): string {
  return `dp-page-mermaid-${index}`;
}

/**
 * Render every Mermaid block in `html`. Never rejects: any failure leaves the
 * block as source with a note. Returns the input unchanged when there are no
 * blocks; otherwise the whole document re-serialized (so the page's own
 * `<html>`/`<body>` attributes survive for both the static and the Run frame).
 */
export async function renderPageMermaid(html: string, opts: PageMermaidOptions): Promise<PageMermaidResult> {
  const unchanged: PageMermaidResult = { html, rendered: 0, fallback: 0, timedOut: 0 };
  if (!pageHasMermaid(html) || typeof DOMParser === "undefined") return unchanged;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = findMermaidBlocks(doc);
  if (blocks.length === 0) return unchanged;

  const renderer = opts.renderer ?? sharedMermaidFrameRenderer().render;
  const maxDiagrams = opts.maxDiagrams ?? PAGE_MERMAID_MAX_DIAGRAMS;
  const maxSource = opts.maxSourceChars ?? PAGE_MERMAID_MAX_SOURCE_CHARS;
  const maxSvg = opts.maxSvgChars ?? PAGE_MERMAID_MAX_SVG_CHARS;
  const timeoutMs = opts.timeoutMs ?? PAGE_MERMAID_TIMEOUT_MS;
  const deadline = Date.now() + (opts.totalTimeoutMs ?? PAGE_MERMAID_TOTAL_TIMEOUT_MS);

  let rendered = 0;
  let fallback = 0;
  let timedOut = 0;
  let unavailable = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const source = (block.textContent ?? "").trim();
    if (!source) continue;
    if (i >= maxDiagrams) { noteAfter(doc, block, PAGE_MERMAID_NOTES.tooMany); fallback++; continue; }
    if (source.length > maxSource) { noteAfter(doc, block, PAGE_MERMAID_NOTES.tooLarge); fallback++; continue; }
    const left = deadline - Date.now();
    if (left <= 0) { noteAfter(doc, block, PAGE_MERMAID_NOTES.timedOut); fallback++; timedOut++; continue; }
    let svgText: string;
    try {
      svgText = await renderWithTimeout(renderer, pageMermaidId(i), source, opts.theme, timeoutMs, left);
    } catch (err) {
      // A renderer that didn't load in time is a timeout (retried later);
      // one that gave up for this tab, or can't run here, is "unavailable"
      // (also never cached), each with its own honest note.
      const late = err instanceof Timeout || err instanceof RendererColdError;
      const gaveUp = err instanceof RendererExhaustedError;
      const absent = gaveUp || err instanceof RendererUnavailableError;
      noteAfter(doc, block, late ? PAGE_MERMAID_NOTES.timedOut
        : gaveUp ? PAGE_MERMAID_NOTES.exhausted
          : absent ? PAGE_MERMAID_NOTES.unavailable : PAGE_MERMAID_NOTES.failed);
      fallback++;
      if (late) timedOut++;
      if (absent) unavailable++;
      continue;
    }
    const svg = typeof svgText === "string" && svgText.length <= maxSvg ? sanitizeMermaidSvg(svgText) : null;
    if (!svg) {
      noteAfter(doc, block, typeof svgText === "string" && svgText.length > maxSvg ? PAGE_MERMAID_NOTES.tooLarge : PAGE_MERMAID_NOTES.failed);
      fallback++;
      continue;
    }
    const wrap = doc.createElement("div");
    wrap.setAttribute("class", "dp-mermaid-render");
    wrap.setAttribute("data-dp-mermaid", "rendered");
    wrap.setAttribute("style", wrapperStyle(opts.theme));
    // Carry the block's own id so a section link or a saved anchor to it still
    // lands on the diagram.
    if (block.id) wrap.id = block.id;
    wrap.appendChild(doc.importNode(svg, true));
    block.replaceWith(wrap);
    rendered++;
  }
  if (rendered === 0 && fallback === 0) return unchanged;
  return { html: doc.documentElement.outerHTML, rendered, fallback, timedOut, ...(unavailable ? { unavailable } : {}) };
}

// ---------------------------------------------------------------------------
// Page queue and the per-version cache
// ---------------------------------------------------------------------------

/** One page at a time, so one page's diagrams aren't interleaved with
 *  another's. Each step is bounded by the page's total timeout, and a timeout
 *  destroys the renderer frame, so nothing waits behind abandoned work. */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

const CACHE_MAX = 8;
const cache = new Map<string, { input: string; theme: PageTheme; out: Promise<string> }>();

function hashKey(s: string): string {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = (Math.imul(b, 33) + c) | 0;
  }
  return `${s.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

/**
 * The page HTML with its diagrams rendered, cached per (page content, theme)
 * — the content identifies the artifact version. Resolves to the input when
 * there is nothing to render. Never rejects.
 */
export function preparePageMermaid(html: string, theme: PageTheme, renderer?: MermaidRenderer): Promise<string> {
  const key = `${theme}|${hashKey(html)}`;
  const hit = cache.get(key);
  if (hit && hit.input === html && hit.theme === theme) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
    return hit.out;
  }
  const entry = { input: html, theme, out: Promise.resolve(html) };
  entry.out = enqueue(() => renderPageMermaid(html, { theme, renderer })).then(
    (r) => {
      // A timeout is not a verdict on the diagram: don't cache it, so the
      // next mount retries.
      if ((r.timedOut > 0 || (r.unavailable ?? 0) > 0) && cache.get(key) === entry) cache.delete(key);
      return r.html;
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key);
      return html;
    },
  );
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return entry.out;
}

/** Test seam: forget cached renders. */
export function clearPageMermaidCache(): void {
  cache.clear();
}

/** The page frame's prepare hook (PageArtifact → PrototypeFrame). */
export const PAGE_MERMAID_PREPARE = {
  needed: pageHasMermaidBlocks,
  run: (html: string, theme: PageTheme) => preparePageMermaid(html, theme),
};
