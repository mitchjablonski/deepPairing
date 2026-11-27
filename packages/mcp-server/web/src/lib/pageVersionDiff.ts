/**
 * #714 gap 2 — what changed between two versions of a `page` artifact, at the
 * level a skimming reviewer reads: blocks (headings, paragraphs, list items,
 * table rows, captions, figures, code blocks, quotes, definitions, summaries,
 * buttons/labels/legends, and leaf sections), each keyed under its nearest
 * preceding heading. Text that sits outside every recognised block (a card's
 * loose line after its heading, loose body text) becomes a SYNTHETIC block
 * owned by its nearest non-inline parent, so no visible text goes unseen.
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
 * Unmatched blocks whose exact text survives elsewhere are MOVED: counted and
 * disclosed, and flagged as a change when they landed under a different
 * heading. The rest pair up inside each gap as CHANGED (same heading, else
 * same position, same tag) or stay ADDED / REMOVED.
 *
 * The frame is told which blocks to highlight with LOCATORS it can re-find
 * without trusting us with markup: `{tag, text, occurrence}` — the element
 * name, its first LOCATOR_TEXT_MAX characters of visible text, and which of
 * the same-tag same-text elements it is. The annotator reads text with the
 * same rules (`clippedText` in pageAnnotator.ts); a parity test evaluates both
 * on shared fixtures.
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

const BLOCK_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "tr", "figure", "pre", "blockquote", "dt", "dd",
  "summary", "caption", "button", "label", "legend",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Section-like containers: a block only when nothing block-level is inside. */
const CONTAINER_TAGS = new Set(["div", "section", "article", "aside", "header", "footer", "main", "nav", "details"]);
/** Inline elements never own loose text; their nearest non-inline ancestor does. */
const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "dfn", "em", "font", "i", "ins", "kbd", "mark",
  "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "img", "svg",
]);
/** Text under these never counts: not rendered, removed by the sanitizer before
 *  Run, or our own annotator layer in the frame. The annotator's CHANGE_SKIP is
 *  this exact string (asserted by the parity test). The layer is matched by its
 *  element name, never by an attribute an author could also write. */
export const TEXT_SKIP_SELECTOR = "script,style,noscript,template,iframe,frame,frameset,object,embed,applet,portal,dp-annotator-layer";

export interface PageBlock {
  tag: string;
  /** The block's own normalized text (text inside nested blocks excluded). */
  text: string;
  /** Nearest preceding heading's text ("" before the first heading). A heading's section is itself. */
  section: string;
  /** Which section, by identity: the index of its heading block (-1 = top). */
  sectionId: number;
  /** Its heading with the enclosing headings: "Option A › Pros". */
  sectionPath?: string;
  heading: boolean;
  /** A run of loose text, owned by its nearest non-inline parent (or body). */
  synthetic?: boolean;
  /** Its owner is too big to outline (body/main/a region): listed, not highlighted. */
  unlocatable?: boolean;
  /** Parsed element, for building a frame locator. Absent in pure tests. */
  el?: Element;
}

export type ChangeKind = "added" | "changed" | "moved" | "hinted";

export interface ChangeLocator {
  kind: ChangeKind;
  tag: string;
  text: string;
  occurrence: number;
}

export interface PageBlockChange {
  /** "moved" = the same text, now under a different heading. */
  kind: "added" | "changed" | "moved";
  block: PageBlock;
  /** The old block a "changed" or "moved" one came from. */
  previous?: PageBlock;
  /** #727 — a heading whose only change is its level (h2 → h3, same text). */
  levelChanged?: boolean;
}

export interface PageBlockDiff {
  /** Added, changed and moved-across-sections blocks, in the new version's order. */
  changes: PageBlockChange[];
  /** Old blocks with no counterpart, in the old version's order. */
  removed: PageBlock[];
  /** Blocks whose exact text moved within the same section (not highlighted). */
  moved: number;
}

export interface PageVersionDiff extends PageBlockDiff {
  /** A side had more than MAX_BLOCKS blocks: the tail was not compared. */
  truncated: boolean;
  /** The two HTML strings are byte-identical. */
  identical: boolean;
  /** No block changed, but the page's full visible text did. */
  textChangedOutsideBlocks: boolean;
  /** What to highlight in the frame (capped at MAX_CHANGE_MARKS): changes, then author hints. */
  marks: ChangeLocator[];
  /** Detected changes that could be highlighted, before the cap. */
  changeMarksTotal: number;
  /** `data-dp-changed` author hints, before the cap. */
  hintMarksTotal: number;
  /** Detected changes in a run of loose text too big to outline (listed, not highlighted). */
  unhighlightable: number;
}

// --- text reading ------------------------------------------------------------

/** Same as the annotator's `norm`: JS `\s` (which covers NBSP) collapsed to one
 *  space, trimmed. Entities are already decoded by the parser. */
export function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function isWs(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";
}

function inSkip(el: Element | null): boolean {
  return !!el && !!el.closest(TEXT_SKIP_SELECTOR);
}

const isCell = (tag: string) => tag === "td" || tag === "th";

/** Is this cell after another cell in its row? (Every such cell starts with
 *  " | ", even when the cells before it are empty.) */
function laterCell(e: Element): boolean {
  for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (isCell(s.localName.toLowerCase())) return true;
  return false;
}

const BUTTON_INPUTS: Record<string, string> = { submit: "Submit", reset: "Reset", button: "" };
const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "number"]);
/** What an <input> shows as text: a button's value (or its default label), a
 *  text-like field's value ATTRIBUTE (never live typing: both sides read the
 *  same markup). Everything else shows no text. */
function inputText(e: Element): string {
  const type = (e.getAttribute("type") ?? "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BUTTON_INPUTS, type)) return e.getAttribute("value") ?? BUTTON_INPUTS[type]!;
  if (TEXT_INPUTS.has(type)) return e.getAttribute("value") ?? "";
  return "";
}

/** A text accumulator with the shared rules: whitespace collapsed, `<br>` is a
 *  space, each table cell after the first in its row starts with " | ", and an
 *  input contributes its rendered label/value. */
class TextBuf {
  text = "";
  lastSpace = true;
  space(): void {
    if (!this.lastSpace) { this.text += " "; this.lastSpace = true; }
  }
  cell(): void {
    this.space();
    this.text += "| ";
    this.lastSpace = true;
  }
  chars(raw: string, max = Infinity): boolean {
    for (let i = 0; i < raw.length; i++) {
      const ch = raw.charAt(i);
      if (isWs(ch)) this.space();
      else { this.text += ch; this.lastSpace = false; }
      if (this.text.length > max) return true;
    }
    return false;
  }
  /** The shared per-element rule. Returns true when `max` was exceeded. */
  element(e: Element, max = Infinity): boolean {
    const tag = e.localName.toLowerCase();
    if (tag === "br") this.space();
    else if (isCell(tag)) { if (laterCell(e)) this.cell(); }
    else if (tag === "input") return this.chars(inputText(e), max);
    return false;
  }
}

function altOf(el: Element): string {
  let t = normText(el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("value") || "");
  if (!t) {
    const imgs = el.getElementsByTagName("img");
    for (let i = 0; i < imgs.length && !t; i++) if (!inSkip(imgs[i]!)) t = normText(imgs[i]!.getAttribute("alt") || "");
  }
  return t;
}

/** The first `max` characters of an element's visible text, read exactly as
 *  the annotator's `clippedText` reads it in the frame (stops once it has
 *  enough). Empty text falls back to alt/aria-label/title/value, then to a
 *  descendant image's alt. */
export function clippedText(el: Element, max = LOCATOR_TEXT_MAX): string {
  const walker = el.ownerDocument.createTreeWalker(el, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
  const buf = new TextBuf();
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 1) {
      if (inSkip(n as Element)) continue;
      if (buf.element(n as Element, max)) break;
      continue;
    }
    if (inSkip(n.parentElement)) continue;
    if (buf.chars(n.nodeValue ?? "", max)) break;
  }
  let t = normText(buf.text);
  if (!t) t = altOf(el);
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

/** A synthetic owner this big is not outlined in the frame (it would frame a
 *  whole region, not the change): body/html/main, more than this many blocks
 *  inside, or more than one heading (it spans sections). The change is still
 *  listed and counted as not highlightable. */
const MAX_OWNER_BLOCKS = 3;

interface Entry {
  el: Element;
  buf: TextBuf;
  pos: number;
  synthetic: boolean;
}

/** Every block in document order, with its own text and section. Loose text
 *  is split into RUNS: each contiguous stretch of loose text between
 *  block-level elements is its own synthetic block at the position it occurs,
 *  so a run after "## Beta" belongs to Beta even when Alpha's run shares the
 *  same parent. */
export function extractPageBlocks(doc: Document, limit = MAX_BLOCKS): { blocks: PageBlock[]; truncated: boolean } {
  const body = doc.body ?? doc.documentElement;
  if (!body) return { blocks: [], truncated: false };
  const all = Array.from(body.getElementsByTagName("*"));
  // Bottom-up: how many blocks does an element contain? One pass in reverse
  // document order (children are visited before their parents).
  const blockDesc = new Map<Element, number>();
  const headingDesc = new Map<Element, number>();
  const isBlock = new Set<Element>();
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i]!;
    const tag = el.localName.toLowerCase();
    if (inSkip(el)) continue;
    const inside = blockDesc.get(el) ?? 0;
    const block = BLOCK_TAGS.has(tag) || (CONTAINER_TAGS.has(tag) && inside === 0);
    if (block) isBlock.add(el);
    const up = inside + (block ? 1 : 0);
    const hUp = (headingDesc.get(el) ?? 0) + (HEADING_TAGS.has(tag) ? 1 : 0);
    if (el.parentElement) {
      if (up) blockDesc.set(el.parentElement, (blockDesc.get(el.parentElement) ?? 0) + up);
      if (hUp) headingDesc.set(el.parentElement, (headingDesc.get(el.parentElement) ?? 0) + hUp);
    }
  }
  const entries: Entry[] = [];
  const byEl = new Map<Element, Entry>();
  const ownerOf = (start: Element | null): Element | null => {
    for (let p = start; p; p = p.parentElement) if (isBlock.has(p)) return p;
    return null;
  };
  const looseOwner = (start: Element | null): Element => {
    let p = start;
    while (p && p !== body && INLINE_TAGS.has(p.localName.toLowerCase())) p = p.parentElement;
    return p ?? body;
  };
  let run: Entry | null = null;
  let counter = 0;
  const walker = doc.createTreeWalker(body, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
  let n: Node | null;
  /** The entry loose content at `parent` goes to: the current run when it is
   *  the same owner and unbroken, else a new run here. */
  const runFor = (parent: Element | null): Entry => {
    const owner = looseOwner(parent);
    if (!run || run.el !== owner) {
      run = { el: owner, buf: new TextBuf(), pos: counter, synthetic: true };
      entries.push(run);
    }
    return run;
  };
  while ((n = walker.nextNode())) {
    counter++;
    if (n.nodeType === 1) {
      const e = n as Element;
      if (inSkip(e)) continue;
      const tag = e.localName.toLowerCase();
      if (isBlock.has(e)) {
        const entry: Entry = { el: e, buf: new TextBuf(), pos: counter, synthetic: false };
        entries.push(entry);
        byEl.set(e, entry);
      }
      // Any block-level element ends the current loose run.
      if (!INLINE_TAGS.has(tag) && tag !== "br" && tag !== "input") run = null;
      if (tag === "br" || isCell(tag) || tag === "input") {
        const owner = ownerOf(e.parentElement);
        if (owner) byEl.get(owner)!.buf.element(e);
        else if (tag === "input" ? inputText(e).trim() : run) runFor(e.parentElement).buf.element(e);
      }
      continue;
    }
    const parent = n.parentElement;
    if (inSkip(parent)) continue;
    const raw = n.nodeValue ?? "";
    const owner = ownerOf(parent);
    if (owner) { byEl.get(owner)!.buf.chars(raw); continue; }
    if (!raw.trim() && !run) continue;
    runFor(parent).buf.chars(raw);
  }
  entries.sort((x, y) => x.pos - y.pos);
  const blocks: PageBlock[] = [];
  let section = "";
  let sectionId = -1;
  let truncated = false;
  const stack: Array<{ level: number; text: string }> = [];
  let sectionPath = "";
  for (const entry of entries) {
    const el = entry.el;
    let text = normText(entry.buf.text);
    if (!text && !entry.synthetic) {
      const imgs = el.getElementsByTagName("img");
      for (let i = 0; i < imgs.length && !text; i++) if (!inSkip(imgs[i]!)) text = normText(imgs[i]!.getAttribute("alt") || "");
    }
    if (!text) continue;
    if (blocks.length >= limit) { truncated = true; break; }
    const tag = el.localName.toLowerCase();
    const heading = !entry.synthetic && HEADING_TAGS.has(tag);
    if (heading) {
      section = text.length > SECTION_LABEL_MAX ? `${text.slice(0, SECTION_LABEL_MAX - 1)}…` : text;
      sectionId = blocks.length;
      const level = Number(tag.slice(1));
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: section });
      sectionPath = stack.map((h) => h.text).join(" › ");
    }
    const block: PageBlock = { tag, text, section, sectionId, sectionPath, heading, el };
    if (entry.synthetic) {
      block.synthetic = true;
      if (
        tag === "body" || tag === "html" || tag === "main" ||
        (blockDesc.get(el) ?? 0) > MAX_OWNER_BLOCKS || (headingDesc.get(el) ?? 0) > 1) {
        block.unlocatable = true;
      }
    }
    blocks.push(block);
  }
  return { blocks, truncated };
}

/** The page's whole visible text, read with the shared rules: the backstop
 *  that keeps "nothing changed" honest when no block caught a change. */
export function visibleText(doc: Document): string {
  const body = doc.body ?? doc.documentElement;
  if (!body) return "";
  const walker = doc.createTreeWalker(body, 5);
  const buf = new TextBuf();
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 1) {
      const e = n as Element;
      if (inSkip(e)) continue;
      const tag = e.localName.toLowerCase();
      if (BLOCK_TAGS.has(tag) || CONTAINER_TAGS.has(tag)) buf.space();
      buf.element(e);
      continue;
    }
    if (inSkip(n.parentElement)) continue;
    buf.chars(n.nodeValue ?? "");
  }
  return normText(buf.text);
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

/** Classify each block as added / changed / moved / removed.
 *
 * Section membership is compared by IDENTITY: matched heading pairs (aligned,
 * moved, or reworded in place) map old sections to new ones, and every matched
 * non-heading pair — aligned ones included — whose old section doesn't map to
 * its new section is a "moved" change. So items moving together across a
 * heading are caught even when alignment kept them and moved the heading, and
 * a move between two sections that share a name ("Pros" under two options) is
 * caught too. */
export function diffPageBlocks(oldBlocks: PageBlock[], newBlocks: PageBlock[]): PageBlockDiff {
  const a = oldBlocks.map(keyOf);
  const b = newBlocks.map(keyOf);
  const aligned = alignKeys(a, b);
  const oldDone = new Uint8Array(a.length);
  const newDone = new Uint8Array(b.length);
  for (const [i, j] of aligned) { oldDone[i] = 1; newDone[j] = 1; }
  /** Every same-text pair (aligned or moved): classified once headings map. */
  const same: Array<[number, number]> = [...aligned];

  // Reorder tolerance: the same block anywhere else in the old version.
  const leftover = new Map<string, number[]>();
  for (let i = 0; i < a.length; i++) {
    if (oldDone[i]) continue;
    const l = leftover.get(a[i]!);
    if (l) l.push(i); else leftover.set(a[i]!, [i]);
  }
  const movedPairs = new Set<number>();
  for (let j = 0; j < b.length; j++) {
    if (newDone[j]) continue;
    const l = leftover.get(b[j]!);
    if (!l || !l.length) continue;
    const i = l.shift()!;
    oldDone[i] = 1;
    newDone[j] = 1;
    same.push([i, j]);
    movedPairs.add(j);
  }

  const changeAt = new Map<number, PageBlockChange>();
  const removed: PageBlock[] = [];
  const headingMap = new Map<number, number>();

  // #727 — body evidence for heading identity: how many same-text body
  // blocks went from under old heading oi to under new heading nj, and how
  // many body blocks each old section had.
  const bodyFollow = new Map<string, number>();
  const bodySize = new Map<number, number>();
  for (const o of oldBlocks) if (!o.heading && o.sectionId >= 0) bodySize.set(o.sectionId, (bodySize.get(o.sectionId) ?? 0) + 1);
  for (const [i, j] of same) {
    const o = oldBlocks[i]!, nb = newBlocks[j]!;
    if (o.heading || nb.heading || o.sectionId < 0 || nb.sectionId < 0) continue;
    const k = `${o.sectionId}:${nb.sectionId}`;
    bodyFollow.set(k, (bodyFollow.get(k) ?? 0) + 1);
  }
  const levelPair = (i: number, j: number) => {
    changeAt.set(j, { kind: "changed", block: newBlocks[j]!, previous: oldBlocks[i]!, levelChanged: true });
    headingMap.set(i, j);
  };

  // Pair the rest inside each gap between aligned pairs.
  const bounds: Array<[number, number]> = [[-1, -1], ...aligned, [a.length, b.length]];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const [a0, b0] = bounds[g]!;
    const [a1, b1] = bounds[g + 1]!;
    const olds: number[] = [];
    const news: number[] = [];
    for (let i = a0 + 1; i < a1; i++) if (!oldDone[i]) olds.push(i);
    for (let j = b0 + 1; j < b1; j++) if (!newDone[j]) news.push(j);
    if (!olds.length && !news.length) continue;
    const paired = new Set<number>();
    const pair = (i: number, j: number) => {
      paired.add(i);
      changeAt.set(j, { kind: "changed", block: newBlocks[j]!, previous: oldBlocks[i]! });
      if (oldBlocks[i]!.heading && newBlocks[j]!.heading) headingMap.set(i, j);
    };
    // 0. #727 — a heading with the same text but another level (h2 → h3) in
    // this gap is the same section: one quiet "changed" on the heading, never
    // a remove + add, and the section keeps its identity so the blocks under
    // it don't read as moved. Only within the gap: a same-text heading
    // elsewhere is a different section. One candidate each side pairs; with
    // more, only if body evidence picks out exactly one pair — otherwise it
    // stays a remove + add.
    const oldByText = new Map<string, number[]>();
    const newByText = new Map<string, number[]>();
    for (const i of olds) if (oldBlocks[i]!.heading) { const q = oldByText.get(oldBlocks[i]!.text); if (q) q.push(i); else oldByText.set(oldBlocks[i]!.text, [i]); }
    for (const j of news) if (newBlocks[j]!.heading) { const q = newByText.get(newBlocks[j]!.text); if (q) q.push(j); else newByText.set(newBlocks[j]!.text, [j]); }
    for (const [text, js] of newByText) {
      const is = oldByText.get(text);
      if (!is) continue;
      if (is.length === 1 && js.length === 1) { paired.add(is[0]!); levelPair(is[0]!, js[0]!); continue; }
      const hits: Array<[number, number]> = [];
      for (const i of is) for (const j of js) if (bodyFollow.get(`${i}:${j}`)) hits.push([i, j]);
      if (hits.length === 1) { paired.add(hits[0]![0]); levelPair(hits[0]![0], hits[0]![1]); }
    }
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
      if (changeAt.has(j)) continue;
      const nb = newBlocks[j]!;
      const q = bySection.get(`${nb.tag}\u0001${nb.heading ? "" : nb.section}`);
      let hit: number | undefined;
      while (q && q.length && hit === undefined) { const i = q.shift()!; if (!paired.has(i)) hit = i; }
      if (hit !== undefined) pair(hit, j);
      else unpairedNew.push(j);
    }
    // 2. Same position in the gap, same tag.
    const unpairedOld = olds.filter((i) => !paired.has(i));
    const k = Math.min(unpairedOld.length, unpairedNew.length);
    for (let x = 0; x < k; x++) {
      const i = unpairedOld[x]!, j = unpairedNew[x]!;
      if (oldBlocks[i]!.tag === newBlocks[j]!.tag) pair(i, j);
    }
    for (const j of unpairedNew) if (!changeAt.has(j)) changeAt.set(j, { kind: "added", block: newBlocks[j]! });
    for (const i of olds) if (!paired.has(i)) removed.push(oldBlocks[i]!);
  }

  // #727 — a section that moved AND changed its heading's level: its old
  // heading (removed) and new one (added) share their text, and most of the
  // section's body went with it (at least half of its body blocks, at least
  // one, now sit under the new heading). That is the same section, moved:
  // one quiet level change plus a counted move. Anything less, or more than
  // one candidate either side, stays a remove + add.
  let movedHeadings = 0;
  const removedHeads = removed.filter((r) => r.heading).map((r) => r.sectionId);
  if (removedHeads.length) {
    const addedHeads = [...changeAt.entries()].filter(([, c]) => c.kind === "added" && c.block.heading).map(([j]) => j);
    const cands: Array<[number, number]> = [];
    for (const oi of removedHeads) {
      for (const nj of addedHeads) {
        if (oldBlocks[oi]!.text !== newBlocks[nj]!.text) continue;
        const followed = bodyFollow.get(`${oi}:${nj}`) ?? 0;
        if (followed >= 1 && followed * 2 >= (bodySize.get(oi) ?? 0)) cands.push([oi, nj]);
      }
    }
    const usedOld = new Set<number>();
    for (const [oi, nj] of cands) {
      if (cands.filter(([x, y]) => x === oi || y === nj).length !== 1) continue;
      usedOld.add(oi);
      levelPair(oi, nj);
      movedHeadings++;
    }
    if (usedOld.size) {
      const keep = removed.filter((r) => !(r.heading && usedOld.has(r.sectionId)));
      removed.length = 0;
      removed.push(...keep);
    }
  }

  // Map sections by identity, then classify every same-text pair.
  for (const [i, j] of same) if (oldBlocks[i]!.heading && newBlocks[j]!.heading) headingMap.set(i, j);
  const sameSection = (o: PageBlock, nb: PageBlock): boolean => {
    if (o.sectionId < 0 || nb.sectionId < 0) return o.sectionId < 0 && nb.sectionId < 0;
    return headingMap.get(o.sectionId) === nb.sectionId;
  };
  let moved = movedHeadings;
  for (const [i, j] of same) {
    const o = oldBlocks[i]!, nb = newBlocks[j]!;
    if (nb.heading) { if (movedPairs.has(j)) moved++; continue; }
    if (!sameSection(o, nb)) changeAt.set(j, { kind: "moved", block: nb, previous: o });
    else if (movedPairs.has(j)) moved++;
  }
  const changes = [...changeAt.entries()].sort((x, y) => x[0] - y[0]).map(([, c]) => c);
  return { changes, removed, moved };
}

// --- locators for the frame ------------------------------------------------------

/** Which of the same-tag, same-clipped-text elements each target is, counted
 *  over EVERY element of that tag (as the annotator counts them). */
function locate(doc: Document, targets: Array<{ el: Element; kind: ChangeKind }>): ChangeLocator[] {
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
        if (inSkip(e)) continue;
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

/** A cached result for this pair, or undefined (never computes). */
export function peekPageVersionDiff(oldHtml: string, newHtml: string): PageVersionDiff | null | undefined {
  return cache.find((c) => c.oldHtml === oldHtml && c.newHtml === newHtml)?.diff;
}

/** Diff two page versions (memoized on the last few pairs). Null when the HTML
 *  can't be parsed. */
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
  const identical = oldHtml === newHtml;
  const o = extractPageBlocks(oldDoc);
  const n = extractPageBlocks(newDoc);
  const d = identical ? { changes: [], removed: [], moved: 0 } : diffPageBlocks(o.blocks, n.blocks);
  const empty = d.changes.length === 0 && d.removed.length === 0 && d.moved === 0;
  const textChangedOutsideBlocks = !identical && empty && visibleText(oldDoc) !== visibleText(newDoc);
  // A run of loose text whose owner is a whole region can't be outlined
  // usefully: it is listed in the summary and counted as not highlightable.
  const changeTargets: Array<{ el: Element; kind: ChangeKind }> = [];
  const seen = new Set<Element>();
  let unhighlightable = 0;
  for (const c of d.changes) {
    const el = c.block.el;
    if (!el || c.block.unlocatable) { unhighlightable++; continue; }
    if (seen.has(el)) continue;
    seen.add(el);
    changeTargets.push({ el, kind: c.kind });
  }
  // #714 — the agent may also mark what it changed: honoured as extra marks.
  const hintTargets: Array<{ el: Element; kind: ChangeKind }> = [];
  for (const el of Array.from(newDoc.querySelectorAll("[data-dp-changed]")).slice(0, MAX_HINTS)) {
    if (seen.has(el) || inSkip(el)) continue;
    seen.add(el);
    hintTargets.push({ el, kind: "hinted" });
  }
  const capped = [...changeTargets, ...hintTargets].slice(0, MAX_CHANGE_MARKS);
  return {
    ...d,
    truncated: o.truncated || n.truncated,
    identical,
    textChangedOutsideBlocks,
    marks: locate(newDoc, capped),
    changeMarksTotal: changeTargets.length,
    hintMarksTotal: hintTargets.length,
    unhighlightable,
  };
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

function nounFor(tags: Set<string>, count: number): string {
  const tag = tags.size === 1 ? [...tags][0]! : "";
  const [one, many] = NOUNS[tag] ?? ["block", "blocks"];
  return count === 1 ? one : many;
}

export interface RemovedGroup {
  /** The old heading the blocks sat under ("" = before any heading). */
  section: string;
  /** Which old section (its heading's block index; -1 = top). Groups are by identity, not name. */
  sectionId: number;
  count: number;
  noun: string;
  /** The removed text, for the reviewer to read (plain text). */
  texts: string[];
}

export interface RemovedSection {
  section: string;
  sectionId: number;
  /** The removed section's body text (its heading excluded). */
  texts: string[];
  noun: string;
}

export interface MovedAcross {
  text: string;
  from: string;
  to: string;
}

export type PageDiffState = "identical" | "markup-only" | "outside-blocks" | "changes";

export interface PageDiffSummary {
  state: PageDiffState;
  changedSections: string[];
  /** #727 — sections whose heading only changed level: name → "h2→h3". */
  headingLevels?: Record<string, string>;
  addedSections: string[];
  removedSections: RemovedSection[];
  removed: RemovedGroup[];
  movedAcross: MovedAcross[];
  /** Blocks that moved within their section (not highlighted). */
  movedCount: number;
  /** Detected changes (added + changed + moved across sections). */
  changeCount: number;
}

const TOP = "";

export function summarizePageDiff(diff: PageBlockDiff & Partial<Pick<PageVersionDiff, "identical" | "textChangedOutsideBlocks">>): PageDiffSummary {
  const addedSections: string[] = [];
  const changedSections: string[] = [];
  const movedAcross: MovedAcross[] = [];
  // A level label only when its name is unambiguous: one changed section by
  // that name (two same-named sections would otherwise share a label).
  const headingLevels: Record<string, string> = {};
  const idsByName: Record<string, number[]> = {};
  for (const c of diff.changes) {
    const ids = (idsByName[c.block.section] ??= []);
    if (!ids.includes(c.block.sectionId)) ids.push(c.block.sectionId);
  }
  for (const c of diff.changes) {
    if (c.levelChanged && c.previous && idsByName[c.block.section]!.length === 1) {
      headingLevels[c.block.section] = `${c.previous.tag}\u2192${c.block.tag}`;
    }
  }
  for (const c of diff.changes) {
    if (c.kind === "added" && c.block.heading && !addedSections.includes(c.block.section)) addedSections.push(c.block.section);
  }
  for (const c of diff.changes) {
    if (c.kind === "moved" && c.previous) {
      const ambiguous = c.previous.section === c.block.section;
      movedAcross.push({
        text: c.block.text,
        from: ambiguous ? c.previous.sectionPath || c.previous.section : c.previous.section,
        to: ambiguous ? c.block.sectionPath || c.block.section : c.block.section,
      });
    }
    const s = c.block.section;
    if (addedSections.includes(s) || changedSections.includes(s)) continue;
    changedSections.push(s);
  }
  // Removed headings take their removed body text with them; the rest is
  // grouped by old section IDENTITY (two sections may share a name).
  const removedHeadingIds = new Set(diff.removed.filter((r) => r.heading).map((r) => r.sectionId));
  const sections = new Map<number, RemovedSection & { tags: Set<string> }>();
  for (const r of diff.removed) {
    if (r.heading) sections.set(r.sectionId, { section: r.section, sectionId: r.sectionId, texts: [], noun: "", tags: new Set() });
  }
  const groups = new Map<number, { section: string; tags: Set<string>; texts: string[] }>();
  for (const r of diff.removed) {
    if (r.heading) continue;
    if (removedHeadingIds.has(r.sectionId)) {
      const s = sections.get(r.sectionId)!;
      s.texts.push(r.text);
      s.tags.add(r.tag);
      continue;
    }
    let g = groups.get(r.sectionId);
    if (!g) groups.set(r.sectionId, (g = { section: r.section, tags: new Set(), texts: [] }));
    g.tags.add(r.tag);
    g.texts.push(r.text);
  }
  const removedSections: RemovedSection[] = [...sections.values()].map(({ tags, ...s }) => ({ ...s, noun: nounFor(tags, s.texts.length) }));
  const removed: RemovedGroup[] = [...groups.entries()].map(([sectionId, g]) => ({
    section: g.section,
    sectionId,
    count: g.texts.length,
    noun: nounFor(g.tags, g.texts.length),
    texts: g.texts,
  }));
  const any = diff.changes.length > 0 || diff.removed.length > 0 || diff.moved > 0;
  const state: PageDiffState = any
    ? "changes"
    : diff.identical
      ? "identical"
      : diff.textChangedOutsideBlocks
        ? "outside-blocks"
        : "markup-only";
  return { state, changedSections, ...(Object.keys(headingLevels).length ? { headingLevels } : {}), addedSections, removedSections, removed, movedAcross, movedCount: diff.moved, changeCount: diff.changes.length };
}

export function sectionLabel(section: string): string {
  return section === TOP ? "Top of page" : section;
}

function list(names: string[], max = 6, label: (name: string) => string = sectionLabel): string {
  const shown = names.slice(0, max).map(label);
  return names.length > max ? `${shown.join(", ")} and ${names.length - max} more` : shown.join(", ");
}

function clipQuote(t: string, n = 60): string {
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export const STATE_COPY: Record<Exclude<PageDiffState, "changes">, string> = {
  identical: "Page content unchanged.",
  "markup-only": "No change found in the compared text (attributes, styling and live form state aren't compared).",
  "outside-blocks": "Text changed outside recognised blocks.",
};

/** "Changed: Storage, Rollout; Added: Risks; Removed: 2 paragraphs under Costs".
 *  Plain text: render it as a text node, never as markup. */
export function formatPageDiffSummary(s: PageDiffSummary): string {
  if (s.state !== "changes") return STATE_COPY[s.state];
  const parts: string[] = [];
  if (s.changedSections.length) {
    const levels = s.headingLevels ?? {};
    const label = (n: string) => (Object.hasOwn(levels, n) ? `${sectionLabel(n)} (${levels[n]})` : sectionLabel(n));
    parts.push(`Changed: ${list(s.changedSections, 6, label)}`);
  }
  if (s.addedSections.length) parts.push(`Added: ${list(s.addedSections)}`);
  if (s.movedAcross.length) {
    const shown = s.movedAcross.slice(0, 3).map((m) => `“${clipQuote(m.text)}” from ${sectionLabel(m.from)} to ${sectionLabel(m.to)}`);
    if (s.movedAcross.length > 3) shown.push(`${s.movedAcross.length - 3} more`);
    parts.push(`Moved: ${shown.join(", ")}`);
  }
  const removed: string[] = [];
  for (const r of s.removedSections.slice(0, 4)) {
    removed.push(`section ${sectionLabel(r.section)}${r.texts.length ? ` (${r.texts.length} ${r.noun})` : ""}`);
  }
  if (s.removedSections.length > 4) removed.push(`${s.removedSections.length - 4} more sections`);
  for (const g of s.removed.slice(0, 4)) {
    removed.push(`${g.count} ${g.noun} ${g.section === TOP ? "at the top of the page" : `under ${g.section}`}`);
  }
  if (s.removed.length > 4) removed.push(`more in ${s.removed.length - 4} other sections`);
  if (removed.length) parts.push(`Removed: ${removed.join(", ")}`);
  if (s.movedCount) parts.push(`${s.movedCount} ${s.movedCount === 1 ? "block" : "blocks"} moved`);
  return parts.join("; ");
}
