/**
 * #714 gap 2 — what changed between two versions of a `page` artifact, at the
 * level a skimming reviewer reads: blocks (headings, paragraphs, list items,
 * table rows, figures, code blocks, quotes, definitions, and leaf sections),
 * each keyed under its nearest preceding heading.
 *
 * Computed in the COMPANION, never in the frame, and never by running the page:
 * both versions are parsed with `DOMParser` ("text/html" documents are inert —
 * no script runs, nothing loads, and nothing is inserted into the live DOM).
 * Only text is read back out.
 *
 * The diff itself (`diffPageBlocks`) is pure and bounded:
 *  - common prefix/suffix trimmed first (the usual "one paragraph changed");
 *  - the middle aligned patience-style (blocks unique on both sides anchor a
 *    longest increasing subsequence, O(n log n)), recursing into the gaps;
 *  - a gap small enough (≤ MAX_DP_CELLS) gets an exact LCS table;
 *  - a gap too big for the table with no unique anchors (or too deep) falls back
 *    to an in-order greedy match, linear in the gap.
 * So a 2 MiB page (capped at MAX_BLOCKS blocks a side) never goes quadratic.
 * Unmatched blocks whose exact text survives elsewhere count as MOVED (no
 * highlight); the rest pair up inside each gap as CHANGED (same heading, else
 * same position, same tag) or stay ADDED / REMOVED.
 *
 * The frame is told which blocks to highlight with LOCATORS it can re-find
 * without trusting us with markup: `{tag, text, occurrence}` — the element
 * name, its first LOCATOR_TEXT_MAX characters of normalized text, and which of
 * the same-tag same-text elements it is. The annotator computes the same text
 * the same way (`clippedText` in pageAnnotator.ts; keep the two in step).
 */

/** Matches the frame annotator's LIMITS.quote — the locator text clip. */
export const LOCATOR_TEXT_MAX = 280;
/** Most blocks read from one version; beyond it the diff says it is partial. */
export const MAX_BLOCKS = 20000;
/** Largest gap (old × new blocks) aligned with an exact LCS table. */
export const MAX_DP_CELLS = 120_000;
/** Most locators sent to the frame (the annotator caps at the same number). */
export const MAX_CHANGE_MARKS = 300;
/** Most `data-dp-changed` hints honoured. */
const MAX_HINTS = 50;
const MAX_DEPTH = 32;
const SECTION_LABEL_MAX = 80;

const BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "tr", "figure", "pre", "blockquote", "dt", "dd"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Section-like containers: a block only when nothing block-level is inside. */
const CONTAINER_TAGS = new Set(["div", "section", "article", "aside", "header", "footer", "main", "nav", "details"]);
/** Text under these never counts: not rendered, or removed by the sanitizer
 *  before Run. Mirrored by CHANGE_SKIP in the annotator. */
export const TEXT_SKIP_SELECTOR = "script,style,noscript,template,iframe,frame,frameset,object,embed,applet,portal,[data-dp-annotator]";

export interface PageBlock {
  tag: string;
  /** The block's own normalized text (text inside nested blocks excluded). */
  text: string;
  /** Nearest preceding heading's text ("" before the first heading). A heading's section is itself. */
  section: string;
  heading: boolean;
  /** Parsed element, for building a frame locator. Absent in pure tests. */
  el?: Element;
}

export interface ChangeLocator {
  kind: "added" | "changed" | "hinted";
  tag: string;
  text: string;
  occurrence: number;
}

export interface PageBlockChange {
  kind: "added" | "changed";
  block: PageBlock;
  /** The old block a "changed" one replaced. */
  previous?: PageBlock;
}

export interface PageBlockDiff {
  /** Added and changed blocks, in the new version's order. */
  changes: PageBlockChange[];
  /** Old blocks with no counterpart, in the old version's order. */
  removed: PageBlock[];
  /** Blocks whose exact text moved elsewhere (not highlighted). */
  moved: number;
}

export interface PageVersionDiff extends PageBlockDiff {
  /** A side had more than MAX_BLOCKS blocks: the tail was not compared. */
  truncated: boolean;
  /** What to highlight in the frame: changes first, then agent hints. */
  marks: ChangeLocator[];
}

// --- normalization -----------------------------------------------------------

/** Same as the annotator's `norm`: JS `\s` (which covers NBSP) collapsed to one
 *  space, trimmed. Entities are already decoded by the parser. */
export function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function isWs(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";
}

function skipped(node: Node): boolean {
  const p = node.parentElement;
  return !!p && !!p.closest(TEXT_SKIP_SELECTOR);
}

/** The first `max` characters of an element's normalized visible text, read
 *  exactly as the annotator's `clippedText` reads it in the frame (stops
 *  walking once it has enough). Empty text falls back to alt/aria-label/title/
 *  value, as the annotator's elementText does. */
export function clippedText(el: Element, max = LOCATOR_TEXT_MAX): string {
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
  let text = "";
  let lastSpace = true;
  let n: Node | null;
  outer: while ((n = walker.nextNode())) {
    if (skipped(n)) continue;
    const raw = n.nodeValue ?? "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw.charAt(i);
      if (isWs(ch)) {
        if (!lastSpace) { text += " "; lastSpace = true; }
      } else { text += ch; lastSpace = false; }
      if (text.length > max) break outer;
    }
  }
  let t = normText(text);
  if (!t) {
    t = normText(el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("value") || "");
  }
  return t.length > max ? t.slice(0, max) : t;
}

// --- extraction ----------------------------------------------------------------

/** Parse page HTML into an INERT document (DOMParser never runs scripts or
 *  loads resources). Null when no DOMParser is available. */
export function parsePageHtml(html: string): Document | null {
  if (typeof DOMParser === "undefined") return null;
  try {
    return new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
}

/** Every block in document order, with its own text and section. */
export function extractPageBlocks(doc: Document, limit = MAX_BLOCKS): { blocks: PageBlock[]; truncated: boolean } {
  const body = doc.body ?? doc.documentElement;
  if (!body) return { blocks: [], truncated: false };
  const all = Array.from(body.getElementsByTagName("*"));
  // Bottom-up: does an element contain anything block-level? One pass in
  // reverse document order (children are visited before their parents).
  const hasBlockDesc = new Set<Element>();
  const isBlock = new Set<Element>();
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i]!;
    const tag = el.localName.toLowerCase();
    if (el.closest(TEXT_SKIP_SELECTOR)) continue;
    const block = BLOCK_TAGS.has(tag) || (CONTAINER_TAGS.has(tag) && !hasBlockDesc.has(el));
    if (block) isBlock.add(el);
    if ((block || hasBlockDesc.has(el)) && el.parentElement) hasBlockDesc.add(el.parentElement);
  }
  // Own text: each text node goes to its nearest block ancestor.
  const own = new Map<Element, string[]>();
  const walker = doc.createTreeWalker(body, 4 /* SHOW_TEXT */);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (skipped(n)) continue;
    let p = n.parentElement;
    while (p && !isBlock.has(p)) p = p.parentElement;
    if (!p) continue;
    let parts = own.get(p);
    if (!parts) own.set(p, (parts = []));
    parts.push(n.nodeValue ?? "");
  }
  const blocks: PageBlock[] = [];
  let section = "";
  let truncated = false;
  for (const el of all) {
    if (!isBlock.has(el)) continue;
    let text = normText((own.get(el) ?? []).join(""));
    if (!text) {
      const alt = el.querySelector("img[alt]")?.getAttribute("alt");
      text = alt ? normText(alt) : "";
    }
    if (!text) continue;
    const tag = el.localName.toLowerCase();
    const heading = HEADING_TAGS.has(tag);
    if (heading) section = text.length > SECTION_LABEL_MAX ? `${text.slice(0, SECTION_LABEL_MAX - 1)}…` : text;
    if (blocks.length >= limit) { truncated = true; break; }
    blocks.push({ tag, text, section, heading, el });
  }
  return { blocks, truncated };
}

// --- alignment -------------------------------------------------------------------

/** Longest strictly increasing subsequence of `seq` (indices into it), O(n log n). */
function lis(seq: number[]): number[] {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out: number[] = [];
  let k = tails.length ? tails[tails.length - 1]! : -1;
  while (k !== -1) { out.push(k); k = prev[k]!; }
  return out.reverse();
}

function lcsTable(a: string[], aLo: number, aHi: number, b: string[], bLo: number, bHi: number, out: Array<[number, number]>): void {
  const n = aHi - aLo, m = bHi - bLo;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[aLo + i] === b[bLo + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[aLo + i] === b[bLo + j]) { out.push([aLo + i, bLo + j]); i++; j++; }
    else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
    else j++;
  }
}

/** In-order greedy: each new block takes the next unused old block with the
 *  same key after the last match. Linear (amortized) in the gap. */
function greedy(a: string[], aLo: number, aHi: number, b: string[], bLo: number, bHi: number, out: Array<[number, number]>): void {
  const pos = new Map<string, { idx: number[]; p: number }>();
  for (let i = aLo; i < aHi; i++) {
    const e = pos.get(a[i]!);
    if (e) e.idx.push(i); else pos.set(a[i]!, { idx: [i], p: 0 });
  }
  let last = aLo - 1;
  for (let j = bLo; j < bHi; j++) {
    const e = pos.get(b[j]!);
    if (!e) continue;
    while (e.p < e.idx.length && e.idx[e.p]! <= last) e.p++;
    if (e.p < e.idx.length) { last = e.idx[e.p]!; e.p++; out.push([last, j]); }
  }
}

function alignRange(a: string[], aLo: number, aHi: number, b: string[], bLo: number, bHi: number, depth: number, out: Array<[number, number]>): void {
  // Trim the common prefix and suffix.
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) out.push([aLo++, bLo++]);
  const tail: Array<[number, number]> = [];
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) tail.push([--aHi, --bHi]);
  if (aLo < aHi && bLo < bHi) {
    if ((aHi - aLo) * (bHi - bLo) <= MAX_DP_CELLS) {
      lcsTable(a, aLo, aHi, b, bLo, bHi, out);
    } else {
      // Patience anchors: keys exactly once on each side.
      const counts = new Map<string, { ca: number; cb: number; ia: number }>();
      for (let i = aLo; i < aHi; i++) {
        const c = counts.get(a[i]!);
        if (c) c.ca++; else counts.set(a[i]!, { ca: 1, cb: 0, ia: i });
      }
      const anchorsB: number[] = [];
      const anchorsA: number[] = [];
      for (let j = bLo; j < bHi; j++) {
        const c = counts.get(b[j]!);
        if (c) c.cb++;
      }
      for (let j = bLo; j < bHi; j++) {
        const c = counts.get(b[j]!);
        if (c && c.ca === 1 && c.cb === 1) { anchorsB.push(j); anchorsA.push(c.ia); }
      }
      if (anchorsA.length === 0 || depth >= MAX_DEPTH) {
        greedy(a, aLo, aHi, b, bLo, bHi, out);
      } else {
        let pa = aLo, pb = bLo;
        for (const k of lis(anchorsA)) {
          const ia = anchorsA[k]!, ib = anchorsB[k]!;
          alignRange(a, pa, ia, b, pb, ib, depth + 1, out);
          out.push([ia, ib]);
          pa = ia + 1; pb = ib + 1;
        }
        alignRange(a, pa, aHi, b, pb, bHi, depth + 1, out);
      }
    }
  }
  for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]!);
}

/** Matched (oldIndex, newIndex) pairs, both strictly increasing. */
export function alignKeys(a: string[], b: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  alignRange(a, 0, a.length, b, 0, b.length, 0, out);
  return out;
}

const keyOf = (b: PageBlock): string => `${b.tag}\u0001${b.text}`;

/** Classify each block as added / changed / removed (moved blocks unflagged). */
export function diffPageBlocks(oldBlocks: PageBlock[], newBlocks: PageBlock[]): PageBlockDiff {
  const a = oldBlocks.map(keyOf);
  const b = newBlocks.map(keyOf);
  const pairs = alignKeys(a, b);
  const oldDone = new Uint8Array(a.length);
  const newDone = new Uint8Array(b.length);
  for (const [i, j] of pairs) { oldDone[i] = 1; newDone[j] = 1; }

  // Reorder tolerance: the same block anywhere else in the old version moved.
  let moved = 0;
  const leftover = new Map<string, number[]>();
  for (let i = 0; i < a.length; i++) {
    if (oldDone[i]) continue;
    const l = leftover.get(a[i]!);
    if (l) l.push(i); else leftover.set(a[i]!, [i]);
  }
  for (let j = 0; j < b.length; j++) {
    if (newDone[j]) continue;
    const l = leftover.get(b[j]!);
    if (l && l.length) { const i = l.shift()!; oldDone[i] = 1; newDone[j] = 1; moved++; }
  }

  // Pair the rest inside each gap between aligned pairs.
  const changeAt = new Map<number, PageBlockChange>();
  const removed: PageBlock[] = [];
  const bounds: Array<[number, number]> = [[-1, -1], ...pairs, [a.length, b.length]];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const [a0, b0] = bounds[g]!;
    const [a1, b1] = bounds[g + 1]!;
    const olds: number[] = [];
    const news: number[] = [];
    for (let i = a0 + 1; i < a1; i++) if (!oldDone[i]) olds.push(i);
    for (let j = b0 + 1; j < b1; j++) if (!newDone[j]) news.push(j);
    if (!olds.length && !news.length) continue;
    const paired = new Set<number>();
    // 1. Same tag under the same heading.
    const bySection = new Map<string, number[]>();
    for (const i of olds) {
      const o = oldBlocks[i]!;
      const k = `${o.tag}\u0001${o.heading ? "" : o.section}`;
      const q = bySection.get(k);
      if (q) q.push(i); else bySection.set(k, [i]);
    }
    const unpairedNew: number[] = [];
    for (const j of news) {
      const nb = newBlocks[j]!;
      const q = bySection.get(`${nb.tag}\u0001${nb.heading ? "" : nb.section}`);
      let hit: number | undefined;
      while (q && q.length && hit === undefined) { const i = q.shift()!; if (!paired.has(i)) hit = i; }
      if (hit !== undefined) {
        paired.add(hit);
        changeAt.set(j, { kind: "changed", block: nb, previous: oldBlocks[hit]! });
      } else unpairedNew.push(j);
    }
    // 2. Same position in the gap, same tag.
    const unpairedOld = olds.filter((i) => !paired.has(i));
    const k = Math.min(unpairedOld.length, unpairedNew.length);
    for (let x = 0; x < k; x++) {
      const i = unpairedOld[x]!, j = unpairedNew[x]!;
      if (oldBlocks[i]!.tag === newBlocks[j]!.tag) {
        paired.add(i);
        changeAt.set(j, { kind: "changed", block: newBlocks[j]!, previous: oldBlocks[i]! });
      }
    }
    for (const j of unpairedNew) if (!changeAt.has(j)) changeAt.set(j, { kind: "added", block: newBlocks[j]! });
    for (const i of olds) if (!paired.has(i)) removed.push(oldBlocks[i]!);
  }
  const changes = [...changeAt.entries()].sort((x, y) => x[0] - y[0]).map(([, c]) => c);
  return { changes, removed, moved };
}

// --- locators for the frame ------------------------------------------------------

/** Which of the same-tag, same-clipped-text elements each target is, counted
 *  over EVERY element of that tag (as the annotator counts them). */
function locate(doc: Document, targets: Array<{ el: Element; kind: ChangeLocator["kind"] }>): ChangeLocator[] {
  // Per tag, one pass: each element's clipped text and its occurrence index.
  const byTag = new Map<string, Map<Element, { text: string; occurrence: number }>>();
  const out: ChangeLocator[] = [];
  for (const { el, kind } of targets) {
    const tag = el.localName.toLowerCase();
    let index = byTag.get(tag);
    if (!index) {
      index = new Map();
      const seen = new Map<string, number>();
      const els = doc.getElementsByTagName(tag);
      for (let i = 0; i < els.length; i++) {
        const e = els[i]!;
        if (e.closest(TEXT_SKIP_SELECTOR)) continue;
        const text = clippedText(e);
        const occurrence = seen.get(text) ?? 0;
        seen.set(text, occurrence + 1);
        index.set(e, { text, occurrence });
      }
      byTag.set(tag, index);
    }
    const at = index.get(el);
    if (!at || !at.text) continue;
    out.push({ kind, tag, text: at.text, occurrence: at.occurrence });
  }
  return out;
}

// --- top level ---------------------------------------------------------------------

const cache: Array<{ oldHtml: string; newHtml: string; diff: PageVersionDiff | null }> = [];

/** Diff two page versions (memoized on the last few pairs: the page header and
 *  RevisionDiff ask for the same pair). Null when the HTML can't be parsed. */
export function computePageVersionDiff(oldHtml: string, newHtml: string): PageVersionDiff | null {
  const hit = cache.find((c) => c.oldHtml === oldHtml && c.newHtml === newHtml);
  if (hit) return hit.diff;
  const diff = computeUncached(oldHtml, newHtml);
  cache.unshift({ oldHtml, newHtml, diff });
  if (cache.length > 4) cache.pop();
  return diff;
}

function computeUncached(oldHtml: string, newHtml: string): PageVersionDiff | null {
  const oldDoc = parsePageHtml(oldHtml);
  const newDoc = parsePageHtml(newHtml);
  if (!oldDoc || !newDoc) return null;
  const o = extractPageBlocks(oldDoc);
  const n = extractPageBlocks(newDoc);
  const d = diffPageBlocks(o.blocks, n.blocks);
  const targets: Array<{ el: Element; kind: ChangeLocator["kind"] }> = [];
  const seen = new Set<Element>();
  for (const c of d.changes) {
    if (targets.length >= MAX_CHANGE_MARKS) break;
    if (c.block.el && !seen.has(c.block.el)) { seen.add(c.block.el); targets.push({ el: c.block.el, kind: c.kind }); }
  }
  // #714 — the agent may also mark what it changed: honoured as extra marks.
  const hinted = Array.from(newDoc.querySelectorAll("[data-dp-changed]")).slice(0, MAX_HINTS);
  for (const el of hinted) {
    if (targets.length >= MAX_CHANGE_MARKS) break;
    if (seen.has(el) || el.closest(TEXT_SKIP_SELECTOR)) continue;
    seen.add(el);
    targets.push({ el, kind: "hinted" });
  }
  return { ...d, truncated: o.truncated || n.truncated, marks: locate(newDoc, targets) };
}

// --- summary -----------------------------------------------------------------------

const NOUNS: Record<string, [string, string]> = {
  p: ["paragraph", "paragraphs"],
  li: ["list item", "list items"],
  tr: ["table row", "table rows"],
  pre: ["code block", "code blocks"],
  blockquote: ["quote", "quotes"],
  figure: ["figure", "figures"],
  dt: ["term", "terms"],
  dd: ["definition", "definitions"],
};

export interface RemovedGroup {
  /** The old heading the blocks sat under ("" = before any heading). */
  section: string;
  count: number;
  noun: string;
  /** The removed text, for the reviewer to read (plain text). */
  texts: string[];
}

export interface PageDiffSummary {
  changedSections: string[];
  addedSections: string[];
  removedSections: string[];
  removed: RemovedGroup[];
  /** Number of highlights the frame can show (changed + added blocks). */
  changeCount: number;
}

const TOP = "";

export function summarizePageDiff(diff: PageBlockDiff): PageDiffSummary {
  const addedSections: string[] = [];
  const changedSections: string[] = [];
  const removedSections: string[] = [];
  for (const c of diff.changes) {
    if (c.kind === "added" && c.block.heading && !addedSections.includes(c.block.section)) addedSections.push(c.block.section);
  }
  for (const c of diff.changes) {
    const s = c.block.section;
    if (addedSections.includes(s) || changedSections.includes(s)) continue;
    changedSections.push(s);
  }
  for (const r of diff.removed) if (r.heading && !removedSections.includes(r.section)) removedSections.push(r.section);
  const groups = new Map<string, { tags: Set<string>; texts: string[] }>();
  for (const r of diff.removed) {
    if (r.heading || removedSections.includes(r.section)) continue;
    let g = groups.get(r.section);
    if (!g) groups.set(r.section, (g = { tags: new Set(), texts: [] }));
    g.tags.add(r.tag);
    g.texts.push(r.text);
  }
  const removed: RemovedGroup[] = [...groups.entries()].map(([section, g]) => {
    const tag = g.tags.size === 1 ? [...g.tags][0]! : "";
    const [one, many] = NOUNS[tag] ?? ["block", "blocks"];
    return { section, count: g.texts.length, noun: g.texts.length === 1 ? one : many, texts: g.texts };
  });
  return { changedSections, addedSections, removedSections, removed, changeCount: diff.changes.length };
}

export function sectionLabel(section: string): string {
  return section === TOP ? "Top of page" : section;
}

function list(names: string[], max = 6): string {
  const shown = names.slice(0, max).map(sectionLabel);
  return names.length > max ? `${shown.join(", ")} and ${names.length - max} more` : shown.join(", ");
}

/** "Changed: Storage, Rollout; Added: Risks; Removed: 2 paragraphs under Costs".
 *  Plain text: render it as a text node, never as markup. */
export function formatPageDiffSummary(s: PageDiffSummary): string {
  const parts: string[] = [];
  if (s.changedSections.length) parts.push(`Changed: ${list(s.changedSections)}`);
  if (s.addedSections.length) parts.push(`Added: ${list(s.addedSections)}`);
  const removed: string[] = [];
  if (s.removedSections.length) removed.push(`${s.removedSections.length === 1 ? "section" : "sections"} ${list(s.removedSections)}`);
  for (const g of s.removed.slice(0, 4)) {
    removed.push(`${g.count} ${g.noun} ${g.section === TOP ? "at the top of the page" : `under ${g.section}`}`);
  }
  if (s.removed.length > 4) removed.push(`more in ${s.removed.length - 4} other sections`);
  if (removed.length) parts.push(`Removed: ${removed.join(", ")}`);
  return parts.join("; ");
}
