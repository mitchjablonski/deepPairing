import { z } from "zod";
import { HtmlAnchorSchema, PAGE_RULE_OUT_KEY_MAX } from "./comment.js";
import { contentTokens } from "../stopwords.js";

export { PAGE_RULE_OUT_KEY_MAX };

/**
 * #680 slice 4 — "Rule this out" on a spot in a `page` artifact.
 *
 * The human selects an element, text, cell or diagram node in the page review
 * and records a rejected stance from it: the stance's description is the
 * anchored text (derived here, so the companion shows exactly the phrase the
 * server records), the reason is the human's own words, and the page is the
 * source artifact. The existing preflight gate then refuses a later page whose
 * text contains that phrase, citing the reason.
 */

export const PAGE_RULE_OUT_REASON_MAX = 2000;
/** A phrase needs at least this many words of PAGE_RULE_OUT_MIN_WORD_LEN+ letters/digits… */
export const PAGE_RULE_OUT_MIN_WORDS = 2;
export const PAGE_RULE_OUT_MIN_WORD_LEN = 2;
/** …or at least this many letters/digits in total. Anything shorter would
 *  block ordinary prose ("Bob" would refuse every page mentioning a Bob). */
export const PAGE_RULE_OUT_MIN_CHARS = 8;

/** Why a spot can't be ruled out, before anything is sent. */
export type PageRuleOutRefusal = "no_text" | "too_short" | "too_generic";

/** The one message for each refusal, shown by the companion before submit and
 *  returned by the server, so the two can't drift. */
export const PAGE_RULE_OUT_MESSAGES: Record<PageRuleOutRefusal, string> = {
  no_text: "That spot has no text to rule out. Select the words you want gone.",
  too_short:
    "That's too short to rule out without blocking ordinary text. Select at least two words, or a longer word or phrase.",
  too_generic:
    "That's only common words, so ruling it out would block ordinary text. Include a word that names the thing you want gone.",
};

/** The phrase after normalization (whitespace, colon rule, cap). */
function normalizeRuleOutPhrase(quote: string): string {
  let key = String(quote ?? "").replace(/\s+/g, " ").trim();
  if (key.includes(":")) {
    key = key
      .split(":")
      .map((part) => part.trim())
      .reduce((best, part) => (part.length > best.length ? part : best), "");
  }
  if (key.length > PAGE_RULE_OUT_KEY_MAX) {
    const cut = key.slice(0, PAGE_RULE_OUT_KEY_MAX);
    const space = cut.lastIndexOf(" ");
    key = (space > 0 ? cut.slice(0, space) : cut).trim();
  }
  return key;
}

/**
 * The stance phrase for an anchor's quote, or why there is none.
 *
 *  - Whitespace collapses to single spaces (the gate reads page text the same way).
 *  - A quote with a colon keeps only its longest colon-free part. The gate
 *    reads "a: b" as category "a" plus specific noun "b" and matches on "b"
 *    alone, so a quote like "Owner: Bob Smith" would quietly become a stance
 *    on "bob smith". The longest part is what the human most plausibly meant,
 *    and it is still a literal substring of the page, so it matches the page.
 *  - Capped at PAGE_RULE_OUT_KEY_MAX at a word boundary, never with an
 *    ellipsis: the phrase has to stay a literal substring of the page text.
 *  - Long enough to gate on: at least PAGE_RULE_OUT_MIN_WORDS words of
 *    PAGE_RULE_OUT_MIN_WORD_LEN+ letters/digits, or PAGE_RULE_OUT_MIN_CHARS
 *    letters/digits in total (else `too_short`), AND at least one content
 *    token — 3+ letters/digits, not a stopword (else `too_generic`).
 */
export function checkPageRuleOut(quote: string): { ok: true; key: string } | { ok: false; reason: PageRuleOutRefusal } {
  const key = normalizeRuleOutPhrase(quote);
  const words = key.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= PAGE_RULE_OUT_MIN_WORD_LEN);
  const chars = key.replace(/[^\p{L}\p{N}]/gu, "").length;
  if (chars === 0) return { ok: false, reason: "no_text" };
  if (words.length < PAGE_RULE_OUT_MIN_WORDS && chars < PAGE_RULE_OUT_MIN_CHARS) return { ok: false, reason: "too_short" };
  // At least one content token (3+ letters/digits, not a stopword — the same
  // rule the matcher's meaningfulTokens uses), so "of the" or "to be" can't
  // become a stance that refuses ordinary prose.
  if (contentTokens(key).length === 0) return { ok: false, reason: "too_generic" };
  return { ok: true, key };
}

/** The stance phrase for an anchor's quote, or null when it can't be ruled out. */
export function pageRuleOutKey(quote: string): string | null {
  const r = checkPageRuleOut(quote);
  return r.ok ? r.key : null;
}

/**
 * POST /api/artifacts/:artifactId/rule-out. The anchor is validated as strictly
 * as a comment's (it may come from code running in the page's frame); the
 * reason is required and is the human's own text, never composed.
 */
export const PageRuleOutBodySchema = z.object({
  htmlAnchor: HtmlAnchorSchema,
  reason: z
    .string()
    .max(PAGE_RULE_OUT_REASON_MAX)
    .refine((s) => s.trim().length > 0, { message: "Say why you're ruling this out" }),
});
export type PageRuleOutBody = z.infer<typeof PageRuleOutBodySchema>;
