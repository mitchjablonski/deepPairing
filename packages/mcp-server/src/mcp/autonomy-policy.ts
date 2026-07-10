/**
 * #148 — the per-level autonomy policy, extracted to ONE constant so the two
 * surfaces that speak it to the agent can never drift into contradiction:
 *
 *   1. buildFirstCallHint() (first-call-hint.ts) — standing guidance delivered
 *      once per session, BEFORE the agent's first artifact. This is the surface
 *      that lets the dial shape the OPENING ceremony (pre-#148 the level only
 *      ever reached the model via check_feedback, i.e. after the agent had
 *      already posted a full findings artifact the human's "Light"/"Minimal"
 *      setting asked it to skip).
 *   2. handleCheckFeedback() (tools/check-feedback.ts) — the per-poll reminder
 *      line appended to feedback responses.
 *
 * `supervised` is DELIBERATELY absent from this record. Supervised is the
 * default and IS the protocol preamble's full ceremony — there is nothing to
 * add, and both surfaces stay byte-for-byte identical to their pre-#148 shape
 * for a default session (zero hot-path bytes). Do not "fix" that silence by
 * adding a supervised entry.
 */
export type AutonomyLevel = "supervised" | "balanced" | "autonomous";

/**
 * The one-line policy per non-default level. check_feedback appends this
 * verbatim (pre-#148 these exact strings were inlined there — kept
 * byte-identical); the first-call hint leads its per-level block with it.
 */
export const AUTONOMY_POLICY_LINE: Record<Exclude<AutonomyLevel, "supervised">, string> = {
  balanced:
    "Skip findings for simple tasks. Present options only for genuine architectural choices.",
  autonomous:
    "Proceed with recommended options. The human will review after. Only present decisions for high-risk or irreversible changes.",
};
