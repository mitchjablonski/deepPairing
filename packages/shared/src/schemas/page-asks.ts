/**
 * #714 gap 5 — the asks an agent marks on a `page` artifact: elements carrying
 * `data-dp-decision` (decide something) or `data-dp-question` (answer
 * something), each with an id (#716's authoring guidance).
 *
 * The companion collects them from the frame (display-only hints) and the MCP
 * server scans them from the page text; both decide "answered" with the SAME
 * rule, kept here so the two can't drift: an ask is answered once a human
 * comment is anchored to the ask's element (its locator or `#id`) or inside it.
 * A comment made on an EARLIER version must also quote the ask's CURRENT text,
 * because a revision can reuse an id or a position for a different ask.
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
  /** More of the ask's text than `text` (server-side, for matching a quote of
   *  a child or a selection anywhere in the ask); defaults to `text`. */
  matchText?: string;
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

/** Text as the matcher compares it: NFKC, curly quotes and apostrophes
 *  folded to ASCII, every whitespace character removed. The frame and the
 *  server space block boundaries differently (a `<br>`) and may spell a
 *  character differently (an entity, a ligature), never the words. */
export function squashAskText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, "\"")
    .replace(/\s+/g, "");
}

/** Below this many squashed characters an ask is too short to match by
 *  substring ("Decide:"): an earlier quote must then equal it exactly. */
export const ASK_MATCH_MIN_ASK = 12;
/** The shortest earlier-version quote that may match inside an ask. */
export const ASK_MATCH_MIN_QUOTE = 8;

/**
 * Does an earlier-version comment still point at THIS ask's text? It guards
 * against a revision reusing an id or a position for a different question,
 * while keeping real answers: a Reply (it quotes the ask text), a click on the
 * ask (its text, perhaps past the clip), a child (an option) or a selection
 * inside it. So: the quote equals the ask's text; or, for an ask of at least
 * ASK_MATCH_MIN_ASK characters, the quote starts with it or is a substring of
 * it of at least ASK_MATCH_MIN_QUOTE characters. A reused id whose text
 * changed fails all three, because the old quote isn't in the new text.
 */
export function quoteMatchesAsk(ask: PageAskRef, quote: string): boolean {
  const t = squashAskText(ask.matchText ?? ask.text);
  const q = squashAskText(quote);
  if (!q || !t) return false;
  if (q === t || squashAskText(ask.text) === q) return true;
  if (t.length < ASK_MATCH_MIN_ASK) return false;
  return q.startsWith(squashAskText(ask.text)) || (q.length >= ASK_MATCH_MIN_QUOTE && t.includes(q));
}

/** Is this comment from an earlier version than `current`? */
export function isEarlierVersionComment(c: PageAskComment, current: PageAskVersion | undefined): boolean {
  if (!current) return false;
  if (c.target.artifactId && c.target.artifactId !== current.artifactId) return true;
  const v = c.target.htmlAnchor?.version;
  return typeof v === "number" && v < current.version;
}

/**
 * Does this comment answer the ask? A HUMAN root comment, not resolved, whose
 * anchor targets the ask, and — when made on an earlier version — whose quote
 * matches the ask's current text. Companion-side, `insideByFrame` means the
 * frame re-found the comment's spot on THIS version inside this ask: that is
 * evidence enough (re-finding already checked the quoted text against the
 * page), so the quote requirement is skipped. The caller passes it only for a
 * pin the frame found.
 */
export function commentAnswersAsk(
  ask: PageAskRef,
  c: PageAskComment,
  current?: PageAskVersion,
  insideByFrame = false,
): boolean {
  if (c.author !== "human" || c.parentCommentId || c.humanResolvedAt) return false;
  const a = c.target.htmlAnchor;
  if (!a || typeof a.locator !== "string" || typeof a.quote !== "string") return false;
  if (insideByFrame) return true;
  if (!anchorTargetsAsk(ask, a)) return false;
  return !isEarlierVersionComment(c, current) || quoteMatchesAsk(ask, a.quote);
}

/** Answered = some comment answers the ask (see commentAnswersAsk). */
export function isPageAskAnswered(
  ask: PageAskRef,
  comments: ReadonlyArray<PageAskComment>,
  current?: PageAskVersion,
): boolean {
  return comments.some((c) => commentAnswersAsk(ask, c, current));
}
