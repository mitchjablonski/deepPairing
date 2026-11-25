/**
 * #714 gap 5 — the asks an agent marks on a `page` artifact: elements carrying
 * `data-dp-decision` (decide something) or `data-dp-question` (answer
 * something), each with an id (#716's authoring guidance).
 *
 * The companion collects them from the frame (display-only hints) and the MCP
 * server scans them from the page text; both decide "answered" with the SAME
 * rule, kept here so the two can't drift: an ask is answered once a human
 * comment is anchored to the ask's element (its locator or `#id`) or inside it.
 * A comment made on an EARLIER version counts only through ASK CONTINUITY: the
 * same ask (same id) existed in the comment's own version with the same FULL
 * text (equal full-text hashes), and the comment targeted it there. A revision can reuse an id for a
 * different question, and then the old answer doesn't carry.
 */

/** Marks a callout that asks the human to decide something. */
export const PAGE_DECISION_ATTR = "data-dp-decision";
/** Marks a callout that asks the human a question. */
export const PAGE_QUESTION_ATTR = "data-dp-question";

export type PageAskKind = "decision" | "question";

/** Bounds shared by the frame collector, the parent schema and the server scanner. */
export const PAGE_ASK_LIMITS = { max: 50, text: 200, id: 200 } as const;

/** Elements whose content never renders in the page frame: the sanitizer
 *  removes them before Run (and they don't render after it), so an ask inside
 *  one is never shown to the human. The companion's sanitizer drops exactly
 *  this set; the server's ask scanner skips their content. */
export const PAGE_SANITIZE_DROP_TAGS = [
  "script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "base",
] as const;

/** What the matcher needs to know about an ask. `locator` is only known
 *  frame-side (the server has no DOM); `childIds` only server-side (ids of
 *  elements inside the ask, so a comment on such a child counts as inside). */
export interface PageAskRef {
  id?: string;
  locator?: string;
  childIds?: readonly string[];
  text: string;
  /** Hash of the ask's FULL text (AskTextHasher over every text chunk, never
   *  the clipped display text). Ask continuity across versions compares it;
   *  absent → the ask can't continue (earlier answers don't carry). */
  fullHash?: string;
}

/** The version a comment is judged against. A comment is from an earlier
 *  version when it targets a different artifact in the chain, or its anchor
 *  records a lower version. */
export interface PageAskVersion {
  artifactId: string;
  version: number;
}

/** A comment the matcher reads (the subset of Comment it needs). */
export interface PageAskComment {
  author: string;
  parentCommentId?: string | null;
  humanResolvedAt?: string | null;
  target: { artifactId?: string; htmlAnchor?: { locator: string; quote: string; version?: number } };
}

/**
 * CSS.escape for an identifier (the CSSOM algorithm), so `#id` locators can be
 * built where `CSS.escape` doesn't exist (the server, jsdom). Mirrors the
 * annotator's fallback, which builds the locators this is compared against.
 */
export function cssEscapeIdent(value: string): string {
  const s = String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const code = s.charCodeAt(i);
    if (code === 0) { out += "�"; continue; }
    if ((code >= 1 && code <= 31) || code === 127 ||
        (i === 0 && code >= 48 && code <= 57) ||
        (i === 1 && code >= 48 && code <= 57 && s.charCodeAt(0) === 45)) {
      out += "\\" + code.toString(16) + " ";
      continue;
    }
    if (i === 0 && s.length === 1 && code === 45) { out += "\\-"; continue; }
    if (code >= 128 || code === 45 || code === 95 || (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      out += ch;
      continue;
    }
    out += "\\" + ch;
  }
  return out;
}

/** Is `locator` this element or inside it? (`a` or `a > …`, never `ab`.) */
function atOrInside(locator: string, base: string): boolean {
  return locator === base || locator.startsWith(base + " > ");
}

/**
 * Is this anchor on the ask? Only when its locator is the ask's element (by
 * the frame's locator or `#id`), a child with its own id, or something inside
 * them. There is deliberately no text fallback: a comment on text that merely
 * repeats the ask (a TL;DR restating the question) must not mark it answered,
 * because a false "answered" hides an open ask from both the human and the
 * agent.
 */
export function anchorTargetsAsk(ask: PageAskRef, anchor: { locator: string }): boolean {
  if (ask.locator && atOrInside(anchor.locator, ask.locator)) return true;
  if (ask.id && atOrInside(anchor.locator, "#" + cssEscapeIdent(ask.id))) return true;
  for (const c of ask.childIds ?? []) if (atOrInside(anchor.locator, "#" + cssEscapeIdent(c))) return true;
  return false;
}

/** NFKC, with curly quotes and apostrophes folded to ASCII. Per character
 *  class only, so it can run on each chunk of a streamed text. */
function foldAskChars(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, "\"");
}

/** Text as the matcher compares it: foldAskChars, every whitespace run
 *  collapsed to one space, trimmed. Words stay apart ("now here" is not
 *  "nowhere"); spelling (an entity, a curly quote) and layout don't matter. */
export function squashAskText(s: string): string {
  return foldAskChars(s).replace(/\s+/g, " ").trim();
}

/**
 * Incremental hash of an ask's FULL text, equal to hashing squashAskText of
 * the concatenated chunks: fed one chunk at a time (a DOM text node in the
 * companion, the source text between two tags on the server — the same
 * boundaries), so neither side holds a large ask's text. A whitespace run is
 * one separator even when it spans chunks; leading and trailing whitespace is
 * dropped; two chunks that meet without whitespace in the source get no
 * separator (`a<b>c</b>d` → "acd", `a <b>c</b>` → "a c"). cyrb53: 53 bits,
 * stable, dependency-free.
 */
export class AskTextHasher {
  private h1 = 0xdeadbeef;
  private h2 = 0x41c6ce57;
  private chars = 0;
  /** A whitespace run was seen after some text and not emitted yet. */
  private pendingSpace = false;

  private emit(ch: number): void {
    this.h1 = Math.imul(this.h1 ^ ch, 2654435761);
    this.h2 = Math.imul(this.h2 ^ ch, 1597334677);
    this.chars++;
  }

  push(chunk: string): void {
    const s = foldAskChars(chunk);
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (/\s/.test(s[i]!)) {
        if (this.chars > 0) this.pendingSpace = true;
        continue;
      }
      if (this.pendingSpace) {
        this.emit(32);
        this.pendingSpace = false;
      }
      this.emit(ch);
    }
  }

  /** The hash, or undefined when no text was pushed. */
  digest(): string | undefined {
    if (this.chars === 0) return undefined;
    let h1 = this.h1;
    let h2 = this.h2;
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return `${n.toString(36)}:${this.chars.toString(36)}`;
  }
}

/** The full-text hash of a whole string (one chunk). */
export function askTextHash(text: string): string | undefined {
  const h = new AskTextHasher();
  h.push(text);
  return h.digest();
}

/**
 * Is `prev` (an ask in an earlier version) the same question as `cur`? Their
 * FULL-text hashes must be equal: exact, no prefix tolerance, so an edit
 * anywhere — including the question at the end of a long preamble — reopens
 * it. A side without a hash (not computed yet, or no text) never continues.
 */
export function askTextsContinue(prev: PageAskRef, cur: PageAskRef): boolean {
  return !!prev.fullHash && prev.fullHash === cur.fullHash;
}

/** The ask in an earlier version's list that `cur` continues: same id (an
 *  id-less ask is matched by its frame locator, when both sides have one). */
export function findEarlierAsk(cur: PageAskRef, earlier: readonly PageAskRef[]): PageAskRef | undefined {
  if (cur.id) return earlier.find((o) => o.id === cur.id);
  if (cur.locator) return earlier.find((o) => !o.id && o.locator === cur.locator);
  return undefined;
}

/** The asks of a version, by artifact id; undefined when its HTML isn't
 *  available (then its comments don't count). */
export type EarlierAsksLookup = (artifactId: string) => readonly PageAskRef[] | undefined;

/** Is this comment from an earlier version than `current`? */
export function isEarlierVersionComment(c: PageAskComment, current: PageAskVersion | undefined): boolean {
  if (!current) return false;
  if (c.target.artifactId && c.target.artifactId !== current.artifactId) return true;
  const v = c.target.htmlAnchor?.version;
  return typeof v === "number" && v < current.version;
}

/**
 * Does this comment answer the ask? A HUMAN root comment, not resolved, and:
 *  - on THIS version: its anchor targets the ask (locator / #id / child id /
 *    inside), or — companion-side — the frame found its pin inside the ask
 *    (`insideByFrame`, only ever passed for a current-version comment);
 *  - on an EARLIER version: ask continuity — `earlierAsks` gives that
 *    version's asks, the same ask is there (findEarlierAsk) with the same
 *    text (askTextsContinue), and the comment targeted it THERE. No lookup,
 *    no such ask, or a reworded ask → it doesn't count (the ask stays open).
 */
export function commentAnswersAsk(
  ask: PageAskRef,
  c: PageAskComment,
  current?: PageAskVersion,
  opts: { insideByFrame?: boolean; earlierAsks?: EarlierAsksLookup } = {},
): boolean {
  if (c.author !== "human" || c.parentCommentId || c.humanResolvedAt) return false;
  const a = c.target.htmlAnchor;
  if (!a || typeof a.locator !== "string" || typeof a.quote !== "string") return false;
  if (!isEarlierVersionComment(c, current)) return opts.insideByFrame === true || anchorTargetsAsk(ask, a);
  const versionId = c.target.artifactId;
  if (!versionId || versionId === current?.artifactId || !opts.earlierAsks) return false;
  const list = opts.earlierAsks(versionId);
  const prev = list ? findEarlierAsk(ask, list) : undefined;
  return !!prev && askTextsContinue(prev, ask) && anchorTargetsAsk(prev, a);
}

/** Answered = some comment answers the ask (see commentAnswersAsk). */
export function isPageAskAnswered(
  ask: PageAskRef,
  comments: ReadonlyArray<PageAskComment>,
  current?: PageAskVersion,
  earlierAsks?: EarlierAsksLookup,
): boolean {
  return comments.some((c) => commentAnswersAsk(ask, c, current, { earlierAsks }));
}
