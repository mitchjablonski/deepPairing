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
 * verbatim; the first-call hint leads its per-level block with it.
 *
 * Q2 — THE MINIMAL FLOOR, MADE TO AGREE WITH WHAT WE SELL.
 *
 * Round 12 caught the `autonomous` line contradicting the README's "Not an
 * autonomous agent" bullet ("the Autonomy dial goes Full / Light / Minimal —
 * and even Minimal stops at the architectural decisions"). The old string said
 * "Only present decisions for high-risk or irreversible changes", which hands
 * the agent a licence the product's own positioning denies: an architectural
 * fork that is neither high-risk nor irreversible — two patterns that are both
 * cheap to undo but shape everything written around them — is exactly the call
 * this tool exists to keep with the human, and the old wording told the agent
 * to make it alone.
 *
 * We fixed the POLICY, not the README, deliberately: "even Minimal stops at
 * the architectural decisions" is the identity claim (see the "Not an
 * autonomous agent" section) and the round-10 risk-adaptive FLOOR — a floor
 * that exempts architectural forks is not a floor. Minimal keeps its real
 * meaning: proceed by default on ordinary work, no findings/plan ceremony,
 * review after. It just stops pretending the fork itself is ordinary work.
 *
 * Q2 review item 10 — MONOTONICITY. Naming the floor in `autonomous` briefly
 * INVERTED the dial: Minimal's options trigger became {architectural fork} ∪
 * {high-risk / irreversible} while Light's was only {architectural choices} —
 * making the QUIETER setting a strict superset of the louder one on this
 * surface. `balanced` now names the same two triggers, so the two are EQUAL on
 * options and Light stays strictly more talkative overall: it still posts
 * findings for non-simple tasks and plans for multi-file changes, both of which
 * Minimal skips. Read the ladder as Full ⊃ Light ⊃ Minimal, always. If you ever
 * add a trigger to `autonomous`, add it to `balanced` first.
 */
export const AUTONOMY_POLICY_LINE: Record<Exclude<AutonomyLevel, "supervised">, string> = {
  balanced:
    "Skip findings for simple tasks. Present options for any genuine architectural choice — and for anything high-risk or irreversible.",
  autonomous:
    "Proceed with your recommended approach on ordinary work — the human reviews after, so skip the findings/plan ceremony. The floor still holds: present_options for a genuine architectural fork (a choice that shapes the code written around it), and for anything high-risk or irreversible. Everything else, just do.",
};
