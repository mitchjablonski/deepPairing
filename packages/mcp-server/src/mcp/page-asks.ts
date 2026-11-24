/**
 * #714 gap 5 — the asks a `page` marks for the human (`data-dp-decision` /
 * `data-dp-question`, #716's authoring callouts), read from the page TEXT on
 * the server so check_feedback can tell the agent which are still unanswered.
 *
 * Like page-text.ts this is NOT an HTML parser and renders nothing: one
 * forward pass with indexOf, the same comment / script / style / template /
 * textarea / plaintext rules, so a 2 MB page of hostile markup stays linear.
 * Per ask it reads the id and the first ~200 characters of its text.
 *
 *  - Attributes are tokenized per tag (quoted values respected; the first of
 *    a duplicated attribute wins, as in a browser).
 *  - An ask's text runs to the close tag that balances its open tag (open
 *    counts per tag name), or until its text budget is full. A `<p>` ask also
 *    ends at the next block that would implicitly close it.
 *  - At most PAGE_ASK_LIMITS.max asks; ids over PAGE_ASK_LIMITS.id are dropped.
 */
import { PAGE_ASK_LIMITS, isPageAskAnswered, type PageAskKind } from "@deeppairing/shared";
import { BLOCK_TAGS, DROP_ELEMENTS, TEXT_ELEMENTS, decodeEntities, opensElement } from "./page-text.js";

export interface PageAskScan {
  id?: string;
  kind: PageAskKind;
  text: string;
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);
/** Opening any of these implicitly closes an open <p>. */
const P_CLOSERS = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
  "section", "table", "ul",
]);
/** Raw characters kept per ask before decoding (entities shrink when decoded). */
const RAW_BUDGET = PAGE_ASK_LIMITS.text * 5;

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

/** The attributes of one tag (`tag` is the text from `<` to `>`), lowercase
 *  names, first occurrence wins. Linear in the tag's length. */
export function tagAttributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = tag.length;
  let i = 1;
  while (i < n && !isSpace(tag.charCodeAt(i)) && tag[i] !== ">" && tag[i] !== "/") i++; // tag name
  while (i < n) {
    while (i < n && (isSpace(tag.charCodeAt(i)) || tag[i] === "/")) i++;
    if (i >= n || tag[i] === ">") break;
    const nameStart = i;
    while (i < n && !isSpace(tag.charCodeAt(i)) && tag[i] !== "=" && tag[i] !== ">" && tag[i] !== "/") i++;
    const name = tag.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(tag.charCodeAt(i))) i++;
    let value = "";
    if (tag[i] === "=") {
      i++;
      while (i < n && isSpace(tag.charCodeAt(i))) i++;
      const q = tag[i];
      if (q === "\"" || q === "'") {
        const end = tag.indexOf(q, i + 1);
        const stop = end === -1 ? n : end;
        value = tag.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const vStart = i;
        while (i < n && !isSpace(tag.charCodeAt(i)) && tag[i] !== ">") i++;
        value = tag.slice(vStart, i);
      }
    }
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

interface Collector {
  ask: PageAskScan;
  tag: string;
  /** The open count of `tag` just inside this element. */
  level: number;
  raw: string;
  fallback: string;
  done: boolean;
}

/** The asks marked on a page, in document order. */
export function extractPageAsks(html: string): PageAskScan[] {
  const lower = html.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  // Fast path: most pages mark no asks.
  if (lower.indexOf("data-dp-decision") === -1 && lower.indexOf("data-dp-question") === -1) return [];
  const n = html.length;
  const lastAt = new Map<string, number>();
  const memoIndexOf = (hay: string, needle: string, from: number): number => {
    const prev = lastAt.get(needle);
    if (prev !== undefined && (prev === -1 || prev >= from)) return prev;
    const at = hay.indexOf(needle, from);
    lastAt.set(needle, at);
    return at;
  };
  /** The end of a tag starting at `lt`: the first `>` outside a quoted
   *  attribute value, or -1. Every search only moves forward and the quote
   *  searches are memoized, so this stays linear on unbalanced quotes. */
  const tagEnd = (lt: number): number => {
    let at = lt + 1;
    while (at < n) {
      const c = html.charCodeAt(at);
      if (c === 62 /* > */) return at;
      if ((c === 34 || c === 39) && /[\s=]/.test(html[at - 1]!)) {
        const end = memoIndexOf(html, html[at]!, at + 1);
        if (end === -1) return memoIndexOf(html, ">", at + 1);
        at = end + 1;
        continue;
      }
      at++;
    }
    return -1;
  };
  const out: PageAskScan[] = [];
  const openCount = new Map<string, number>();
  const stacks = new Map<string, Collector[]>();
  let hungry: Collector[] = [];

  const finish = (c: Collector) => {
    if (c.done) return;
    c.done = true;
    const text = decodeEntities(c.raw).replace(/\s+/g, " ").trim() || c.fallback;
    c.ask.text = text.length > PAGE_ASK_LIMITS.text ? text.slice(0, PAGE_ASK_LIMITS.text) : text;
  };
  const feed = (s: string) => {
    if (hungry.length === 0 || !s) return;
    let full = false;
    for (const c of hungry) {
      if (c.done) { full = true; continue; }
      c.raw += s.slice(0, RAW_BUDGET - c.raw.length);
      if (c.raw.length >= RAW_BUDGET) { finish(c); full = true; }
    }
    if (full) hungry = hungry.filter((c) => !c.done);
  };
  const closeTag = (name: string) => {
    const count = Math.max(0, (openCount.get(name) ?? 0) - 1);
    openCount.set(name, count);
    const stack = stacks.get(name);
    while (stack && stack.length > 0 && stack[stack.length - 1]!.level > count) finish(stack.pop()!);
  };

  let i = 0;
  while (i < n) {
    if (out.length >= PAGE_ASK_LIMITS.max && hungry.length === 0) break;
    const lt = html.indexOf("<", i);
    if (lt === -1) { feed(html.slice(i)); break; }
    feed(html.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      if (lower.startsWith("<!-->", lt)) { i = lt + 5; continue; }
      if (lower.startsWith("<!--->", lt)) { i = lt + 6; continue; }
      const a = memoIndexOf(html, "-->", lt + 4);
      const b = memoIndexOf(html, "--!>", lt + 4);
      const end = a === -1 ? (b === -1 ? -1 : b + 4) : b === -1 || a < b ? a + 3 : b + 4;
      i = end === -1 ? n : end;
      continue;
    }
    const gt = tagEnd(lt);
    if (gt === -1) { feed(html.slice(lt)); break; }
    if (opensElement(lower, lt, "plaintext")) { feed(" " + html.slice(gt + 1)); break; }
    const drop = DROP_ELEMENTS.find((t) => opensElement(lower, lt, t));
    const literal = drop ? undefined : TEXT_ELEMENTS.find((t) => opensElement(lower, lt, t));
    const raw = drop ?? literal;
    if (raw) {
      const close = memoIndexOf(lower, `</${raw}`, gt + 1);
      if (close === -1) { i = gt + 1; continue; }
      if (literal) feed(" " + html.slice(gt + 1, close) + " ");
      const closeEnd = html.indexOf(">", close);
      i = closeEnd === -1 ? n : closeEnd + 1;
      continue;
    }
    const m = /^<(\/?)\s*([a-z][a-z0-9-]*)/.exec(lower.slice(lt, Math.min(gt + 1, lt + 40)));
    i = gt + 1;
    if (!m) continue;
    const name = m[2]!;
    if (BLOCK_TAGS.has(name)) feed(" ");
    if (m[1]) { closeTag(name); continue; }
    if (P_CLOSERS.has(name) && (openCount.get("p") ?? 0) > 0) {
      // An open <p> ends here, however many were left open.
      openCount.set("p", 1);
      closeTag("p");
    }
    const tagLower = lower.slice(lt, gt + 1);
    const isAsk = tagLower.includes("data-dp-decision") || tagLower.includes("data-dp-question");
    const isVoid = VOID_TAGS.has(name);
    if (!isVoid) openCount.set(name, (openCount.get(name) ?? 0) + 1);
    if (!isAsk || out.length >= PAGE_ASK_LIMITS.max) continue;
    const attrs = tagAttributes(html.slice(lt, gt + 1));
    const decision = attrs.has("data-dp-decision");
    if (!decision && !attrs.has("data-dp-question")) continue;
    const ask: PageAskScan = { kind: decision ? "decision" : "question", text: "" };
    const id = decodeEntities(attrs.get("id") ?? "");
    if (id && id.length <= PAGE_ASK_LIMITS.id && !/\s/.test(id)) ask.id = id;
    out.push(ask);
    const fallback = decodeEntities(attrs.get("aria-label") ?? attrs.get("title") ?? attrs.get("alt") ?? "").replace(/\s+/g, " ").trim();
    const c: Collector = { ask, tag: name, level: openCount.get(name) ?? 0, raw: "", fallback, done: false };
    if (isVoid) { finish(c); continue; }
    const stack = stacks.get(name) ?? [];
    stack.push(c);
    stacks.set(name, stack);
    hungry.push(c);
  }
  for (const stack of stacks.values()) for (const c of stack) finish(c);
  return out;
}

/** Scans are memoized per artifact id: a version's HTML never changes. */
const scanCache = new Map<string, PageAskScan[]>();
const SCAN_CACHE_MAX = 32;

export function pageAsksFor(artifactId: string, html: string): PageAskScan[] {
  const hit = scanCache.get(artifactId);
  if (hit) return hit;
  const asks = extractPageAsks(html);
  scanCache.set(artifactId, asks);
  if (scanCache.size > SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value!);
  return asks;
}

/** The asks no human comment is anchored to yet (the companion's rule). */
export function openPageAsks(
  asks: readonly PageAskScan[],
  comments: Parameters<typeof isPageAskAnswered>[1],
): PageAskScan[] {
  return asks.filter((a) => !isPageAskAnswered(a, comments));
}
