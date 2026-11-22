import { z } from "zod";
import { HtmlAnchorSchema, PAGE_RULE_OUT_KEY_MAX } from "./comment.js";

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

/** Fewer letters/digits than this is too short to gate on without blocking ordinary prose. */
export const PAGE_RULE_OUT_KEY_MIN = 3;
export const PAGE_RULE_OUT_REASON_MAX = 2000;

/**
 * The stance phrase for an anchor's quote, or null when there is nothing
 * gateable (an element with no text, or a fragment shorter than the minimum).
 *
 *  - Whitespace collapses to single spaces (the gate reads page text the same way).
 *  - A quote with a colon keeps only its longest colon-free part. The gate
 *    reads "a: b" as category "a" plus specific noun "b" and matches on "b"
 *    alone, so a quote like "Owner: Bob" would quietly become a stance on
 *    "bob". The longest part is what the human most plausibly meant, and it
 *    is still a literal substring of the page, so it matches the page text.
 *  - Capped at PAGE_RULE_OUT_KEY_MAX at a word boundary, never with an
 *    ellipsis: the phrase has to stay a literal substring of the page text.
 */
export function pageRuleOutKey(quote: string): string | null {
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
  const meaningful = key.replace(/[^\p{L}\p{N}]/gu, "").length;
  return meaningful >= PAGE_RULE_OUT_KEY_MIN ? key : null;
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
