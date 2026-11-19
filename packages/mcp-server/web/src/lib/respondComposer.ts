/**
 * #668 item 3 (Mitch, 11-18) — the artifact types whose draft footer is
 * ArtifactStatusActions' "Respond to the agent…" box. While they're in review,
 * Respond (plus its Ask) is the single artifact-level composer, and the panel's
 * Comments thread is read-only history. Debrief and explainer keep their own
 * ask-anything composer; changeset and decision have their own review surfaces.
 */
export const RESPOND_COMPOSER_TYPES: ReadonlySet<string> = new Set(["plan", "spec", "research", "code_change"]);
