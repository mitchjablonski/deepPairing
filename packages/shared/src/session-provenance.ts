/**
 * #569 proposal 1 — the ONE rule for "is this session deepPairing's own demo or
 * sample data, not the human's work?". Shared by the server's context bank
 * (Threads `fixtureLike`) and the companion's live-vs-demo markers, so the
 * two can never disagree about the same session.
 *
 * Deliberately narrow (see store/context-bank.ts for the history): a false
 * "demo" label on real work is as harmful as hiding it, because the human then
 * discounts a card that mattered. So it matches only:
 *   - `demo_*` — an id ONLY `POST /api/demo/run` can mint (FileStore keys its
 *     demo isolation on exactly this prefix, so it is a fact about provenance,
 *     not a guess);
 *   - the exact ids of the sample sessions checked into this repo.
 *
 * Anything else — including every legacy session with no metadata — is real
 * ("live") work. This is not a general "looks like test data" classifier and
 * must not become one.
 */
export const KNOWN_SAMPLE_SESSION_IDS: readonly string[] = ["b-demo", "dv1-demo", "batch2-preview"];

export function isDemoSessionId(sessionId: string | null | undefined): boolean {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  const id = sessionId.toLowerCase();
  return id.startsWith("demo_") || KNOWN_SAMPLE_SESSION_IDS.includes(id);
}
