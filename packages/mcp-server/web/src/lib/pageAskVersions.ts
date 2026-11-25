import {
  AskTextHasher,
  PAGE_ASK_LIMITS,
  askTextHash,
  PAGE_DECISION_ATTR,
  PAGE_QUESTION_ATTR,
  PAGE_SANITIZE_DROP_TAGS,
  type PageAskRef,
} from "@deeppairing/shared";
import { parsePageHtml } from "./pageVersionDiff";

/**
 * #714 gap 5 — the asks of a page version, read from its PARSED (never
 * executed) HTML, for ask continuity: an answer given on v1 carries to v2 only
 * when the same ask (same id) exists on both with the same FULL text (equal
 * full-text hashes) and the comment targeted it on v1. Both the current and
 * the earlier version are read HERE, the same way — the frame's 200-character
 * display text is never used for continuity.
 *
 * The full-text hash is fed one text node at a time, exactly as the server's
 * scanner feeds the text between two tags: script/style/template/title and
 * the sanitizer's drop containers skipped; when an ask has no text, its alt /
 * aria-label / title / value (the annotator's order). Asks inside containers
 * the sanitizer drops are skipped, as the frame never shows them. Only asks with
 * an id are kept: an id-less ask can't be identified across versions here, so
 * an earlier answer to one doesn't carry (it stays open, the safe side).
 */

const ASK_SEL = `[${PAGE_DECISION_ATTR}], [${PAGE_QUESTION_ATTR}]`;
const TEXT_SKIP = "script,style,noscript,template";
const HIDDEN = PAGE_SANITIZE_DROP_TAGS.join(",");
const CHILD_IDS_MAX = 50;

const HASH_SKIP = `${TEXT_SKIP},title,${HIDDEN}`;

function fallbackOf(el: Element): string {
  return (el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("value") || "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The ask's display text (clipped) and its full-text hash, in one walk. */
function readAsk(el: Element, max: number): { text: string; fullHash?: string } {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
  const hasher = new AskTextHasher();
  let text = "";
  let lastSpace = true;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    const value = n.nodeValue ?? "";
    if (!(p && p.closest(HASH_SKIP))) hasher.push(value);
    if (text.length > max || (p && p.closest(TEXT_SKIP))) continue;
    for (const ch of value) {
      if (/\s/.test(ch)) {
        if (!lastSpace) { text += " "; lastSpace = true; }
      } else {
        text += ch;
        lastSpace = false;
      }
      if (text.length > max) break;
    }
  }
  let t = text.replace(/\s+/g, " ").trim();
  const fallback = fallbackOf(el);
  if (!t) t = fallback;
  const fullHash = hasher.digest() ?? (fallback ? askTextHash(fallback) : undefined);
  return { text: t.length > max ? t.slice(0, max) : t, ...(fullHash ? { fullHash } : {}) };
}

/** The id'd asks of a parsed page, with the ids of their own children. */
export function extractVersionAsks(html: string): PageAskRef[] | null {
  const doc = parsePageHtml(html);
  if (!doc) return null;
  const out: PageAskRef[] = [];
  for (const el of Array.from(doc.querySelectorAll(ASK_SEL))) {
    if (out.length >= PAGE_ASK_LIMITS.max) break;
    if (el.closest(HIDDEN)) continue;
    const id = el.id;
    if (!id || id.length > PAGE_ASK_LIMITS.id) continue;
    const childIds: string[] = [];
    for (const c of Array.from(el.querySelectorAll("[id]"))) {
      if (childIds.length >= CHILD_IDS_MAX) break;
      if (c.closest(ASK_SEL) === el && c.id && c.id.length <= PAGE_ASK_LIMITS.id) childIds.push(c.id);
    }
    out.push({ id, ...readAsk(el, PAGE_ASK_LIMITS.text), ...(childIds.length ? { childIds } : {}) });
  }
  return out;
}

/** Parsed once per version (a version's HTML never changes). LRU, up to the
 *  version-chain cap. */
const cache = new Map<string, PageAskRef[] | null>();
const CACHE_MAX = 50;

/** A version's asks if already parsed (never parses; refreshes LRU order). */
export function peekVersionAsks(artifactId: string): PageAskRef[] | null | undefined {
  if (!cache.has(artifactId)) return undefined;
  const hit = cache.get(artifactId)!;
  cache.delete(artifactId);
  cache.set(artifactId, hit);
  return hit;
}

/** A version's asks, parsing (and caching) them if needed. */
export function versionAsks(artifactId: string, html: string): PageAskRef[] | null {
  const hit = peekVersionAsks(artifactId);
  if (hit !== undefined) return hit;
  const asks = extractVersionAsks(html);
  cache.set(artifactId, asks);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return asks;
}
