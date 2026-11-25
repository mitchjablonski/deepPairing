import {
  PAGE_ASK_LIMITS,
  PAGE_DECISION_ATTR,
  PAGE_QUESTION_ATTR,
  PAGE_SANITIZE_DROP_TAGS,
  type PageAskRef,
} from "@deeppairing/shared";
import { parsePageHtml } from "./pageVersionDiff";

/**
 * #714 gap 5 — the asks of an EARLIER page version, read from its PARSED
 * (never executed) HTML, for ask continuity: an answer given on v1 carries to
 * v2 only when the same ask (same id) existed on v1 with the same text and the
 * comment targeted it there.
 *
 * The text is read the way the annotator reads an ask in the frame (text
 * nodes, script/style/noscript/template skipped, whitespace collapsed, alt /
 * aria-label / title / value when empty), clipped at PAGE_ASK_LIMITS.text;
 * the matcher compares it with whitespace removed. Asks inside containers the
 * sanitizer drops are skipped, as the frame never shows them. Only asks with
 * an id are kept: an id-less ask can't be identified across versions here, so
 * an earlier answer to one doesn't carry (it stays open, the safe side).
 */

const ASK_SEL = `[${PAGE_DECISION_ATTR}], [${PAGE_QUESTION_ATTR}]`;
const TEXT_SKIP = "script,style,noscript,template";
const HIDDEN = PAGE_SANITIZE_DROP_TAGS.join(",");
const CHILD_IDS_MAX = 50;

function askText(el: Element, max: number): string {
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
  let text = "";
  let lastSpace = true;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (p && p.closest(TEXT_SKIP)) continue;
    for (const ch of n.nodeValue ?? "") {
      if (/\s/.test(ch)) {
        if (!lastSpace) { text += " "; lastSpace = true; }
      } else {
        text += ch;
        lastSpace = false;
      }
      if (text.length > max) break;
    }
    if (text.length > max) break;
  }
  let t = text.replace(/\s+/g, " ").trim();
  if (!t) {
    t = (el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("value") || "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return t.length > max ? t.slice(0, max) : t;
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
    out.push({ id, text: askText(el, PAGE_ASK_LIMITS.text), ...(childIds.length ? { childIds } : {}) });
  }
  return out;
}

/** Parsed once per version (a version's HTML never changes); a few kept. */
const cache = new Map<string, PageAskRef[] | null>();
const CACHE_MAX = 8;

export function versionAsks(artifactId: string, html: string): PageAskRef[] | null {
  if (cache.has(artifactId)) return cache.get(artifactId)!;
  const asks = extractVersionAsks(html);
  cache.set(artifactId, asks);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return asks;
}
