/**
 * #714 gap 5 — the asks an agent marks on a `page` artifact: elements carrying
 * `data-dp-decision` (decide something) or `data-dp-question` (answer
 * something), each with an id (#716's authoring guidance).
 *
 * The companion collects them from the frame (display-only hints) and the MCP
 * server scans them from the page text; both decide "answered" with the SAME
 * rule, kept here so the two can't drift: an ask is answered once a human
 * comment is anchored to the ask's element (its locator or `#id`) or inside it.
 */

/** Marks a callout that asks the human to decide something. */
export const PAGE_DECISION_ATTR = "data-dp-decision";
/** Marks a callout that asks the human a question. */
export const PAGE_QUESTION_ATTR = "data-dp-question";

export type PageAskKind = "decision" | "question";

/** Bounds shared by the frame collector, the parent schema and the server scanner. */
export const PAGE_ASK_LIMITS = { max: 50, text: 200, id: 200 } as const;

/** What the matcher needs to know about an ask. `locator` is only known
 *  frame-side (the server has no DOM). */
export interface PageAskRef {
  id?: string;
  locator?: string;
  text: string;
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
 * the frame's locator or `#id`) or something inside it. There is deliberately
 * no text fallback: a comment on text that merely repeats the ask (a TL;DR
 * restating the question) must not mark it answered, because a false
 * "answered" hides an open ask from both the human and the agent.
 */
export function anchorTargetsAsk(ask: PageAskRef, anchor: { locator: string; quote: string }): boolean {
  if (ask.locator && atOrInside(anchor.locator, ask.locator)) return true;
  return !!ask.id && atOrInside(anchor.locator, "#" + cssEscapeIdent(ask.id));
}

/** Answered = some HUMAN root comment is anchored to the ask. */
export function isPageAskAnswered(
  ask: PageAskRef,
  comments: ReadonlyArray<{ author: string; parentCommentId?: string | null; target: { htmlAnchor?: { locator: string; quote: string } } }>,
): boolean {
  for (const c of comments) {
    if (c.author !== "human" || c.parentCommentId) continue;
    const a = c.target.htmlAnchor;
    if (a && typeof a.locator === "string" && typeof a.quote === "string" && anchorTargetsAsk(ask, a)) return true;
  }
  return false;
}
