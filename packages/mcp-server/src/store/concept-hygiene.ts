/**
 * Q2 review H2 — hygiene for the string that becomes a CROSS-PROJECT ledger key.
 *
 * The consent surface (the first-reject card, the Autonomy switch, the FAQ)
 * tells the human what publishing sends to `~/.deeppairing`. The adversarial
 * review executed a real publish and found the copy could be wrong: rejecting a
 * CHANGESET falls back to the artifact TITLE as the concept key (routes.ts — a
 * changeset carries no top-level concept), and agents title changesets after the
 * file they touch. So a real ledger entry read:
 *
 *   "packages/api/src/auth/session-store.ts — swap Redis for an in-memory Map"
 *
 * — a source path, published verbatim as the key, from a UI that had just
 * promised no file paths leave the project.
 *
 * Two answers, and the COPY is the load-bearing one (see CrossProjectCard): it
 * now discloses that a stance title can contain whatever you wrote into it.
 * This module is the best-effort half: where the key was NEVER human-authored —
 * the changeset TITLE fallback — strip a leading path-like token, because it is
 * machine-generated noise the human never chose to publish.
 *
 * WHY THIS CANNOT COST RECALL (the review's explicit caution). A cross-project
 * advisory fires on either exact normalized-key equality or FULL stemmed-token
 * containment of the stored concept inside the proposal
 * (isCrossProjectAdvisoryHit). A key carrying
 * `packages/api/src/auth/session-store.ts` demands every one of those path
 * tokens ALSO appear in another project's proposal — which never happens.
 * Stripping the path strictly WIDENS the set of proposals the stance can match;
 * it cannot narrow it. The same holds for the local prose matcher, which is more
 * permissive still.
 *
 * Deliberately narrow: applied ONLY to the changeset-title fallback, never to a
 * concept the human typed at the reject prompt or one the agent named via Y5.
 * If you wrote a path into your stance, we keep your words — and say so.
 */

/**
 * A leading "which file this touches" prefix: a token containing a `/` or `\`,
 * or ending in a file extension, sitting at the very START and followed by a
 * human separator (em/en dash, colon, or a spaced hyphen).
 *
 * Anchored and separator-bound on purpose. "Redis: use a real cache" must not
 * lose "Redis", and "src/lib helpers are fine" (no separator) is prose, not a
 * prefix — both are left alone.
 */
const LEADING_PATH_PREFIX =
  /^\s*([^\s:—–]*[/\\][^\s:—–]*|[^\s:—–]+\.[a-z0-9]{1,6})\s*(?:[—–:]|-\s)\s*/i;

/**
 * Strip a leading path-like token from a MACHINE-DERIVED concept key.
 * Returns the input unchanged when there is no such prefix, or when stripping
 * would leave nothing meaningful behind (a title that is ONLY a path still has
 * to identify something — an empty key records no stance at all).
 */
export function stripLeadingPathToken(title: string): string {
  if (!title) return title;
  const stripped = title.replace(LEADING_PATH_PREFIX, "").trim();
  if (!stripped) return title;
  return stripped;
}

/**
 * Q2 review LOW — a ledger key is a SHORT phrase you could say out loud
 * ("global mutable state for config"). Nothing legitimate is 500 characters,
 * and an unbounded key published into a shared file is both a storage and a
 * disclosure hazard (a pasted diff or stack trace arriving as a "concept").
 * Truncate on the way out, with an ellipsis so a reader can tell it was cut.
 */
export const MAX_PUBLISHED_CONCEPT_CHARS = 500;

export function capConceptLength(concept: string): string {
  if (concept.length <= MAX_PUBLISHED_CONCEPT_CHARS) return concept;
  return `${concept.slice(0, MAX_PUBLISHED_CONCEPT_CHARS - 1).trimEnd()}…`;
}
