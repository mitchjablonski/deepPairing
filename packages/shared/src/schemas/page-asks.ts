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

/** Text compared with every whitespace character removed: the frame and the
 *  server space block boundaries differently (a `<br>`), never the letters. */
function squash(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Does an earlier-version comment quote the ask's CURRENT text? Its quote
 *  must start with the whole (clipped) ask text: a Reply quotes exactly the
 *  ask text, a click on the ask element quotes it plus anything past the
 *  clip. A quote of only part of the ask (a "Decide:" label) never counts. */
export function quoteMatchesAsk(ask: PageAskRef, quote: string): boolean {
  const t = squash(ask.text);
  return t.length > 0 && squash(quote).startsWith(t);
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
 * anchor targets the ask (or, companion-side, whose pin the frame found inside
 * the ask: `insideByFrame`), and — when made on an earlier version — whose
 * quote matches the ask's current text.
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
  if (!insideByFrame && !anchorTargetsAsk(ask, a)) return false;
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
