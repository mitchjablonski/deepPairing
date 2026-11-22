/**
 * Grammatical function words that never help (and shouldn't gate) a concept
 * match. Kept deliberately tiny — the "every meaningful token must appear"
 * semantics already make common words harmless; this only guards the case of
 * a concept whose ONLY tokens are function words. Checked pre-stem.
 *
 * #680 slice 4 — a MIRROR of SHORT_STOPWORDS in mcp-server's
 * preflight-validator.ts, which stays the matcher's authority. The validator
 * can't import it from here: it runs inside the PreToolUse hook, which must
 * stay free of @deeppairing/shared at runtime. The page "Rule this out" needs
 * the same list in the companion and the route (a phrase must name at least
 * one content token), so it lives here too, and
 * mcp-server/src/mcp/__tests__/stopwords-mirror.test.ts fails if the two copies
 * ever differ.
 */
export const SHORT_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "but", "not", "use", "with", "from", "into", "onto",
  "that", "this", "than", "then", "via", "per", "our", "your", "its",
]);

/** Shortest token the matcher counts as meaningful (meaningfulTokens). */
export const MIN_CONTENT_TOKEN_LEN = 3;

/** The meaningful-token rule from the preflight validator, pre-stem: lowercase
 *  letter/digit runs of MIN_CONTENT_TOKEN_LEN+ that are not stopwords. Unlike
 *  the matcher's ASCII tokenizer it keeps non-Latin letters, so a page in
 *  another script can still be ruled out; on ASCII text the two agree. */
export function contentTokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_CONTENT_TOKEN_LEN && !SHORT_STOPWORDS.has(t));
}
