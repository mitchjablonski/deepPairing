/**
 * D7 — THE concept-key normalizer. It existed five times (global-store,
 * format-markdown, and three web mirrors) and the format-markdown copy had
 * already drifted (no whitespace collapse), so a concept with an internal
 * double space deduped in the ledger but split into two entries in exports.
 * One definition; everyone imports it.
 */
export function normalizeConceptKey(name: string): string {
  return String(name).trim().toLowerCase().replace(/\s+/g, " ");
}
