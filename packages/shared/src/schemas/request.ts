import { z } from "zod";
import { SecretWarningSchema } from "./artifact.js";

/**
 * G1 (#198b) — the REQUEST COMPOSER's persisted unit. The human can finally
 * INITIATE: compose a free-text request to the agent, tagged with one of three
 * intent presets that tell the agent which artifact type fulfils it:
 *
 *   - "explain" — "Explain how ___ works"        → present_explainer
 *   - "plan"    — "Plan ___ before building"     → present_plan / present_spec
 *   - "status"  — "Status?"                       → present_debrief-style summary
 *
 * A request is session-scoped and survives daemon restarts (it lives in the
 * per-project session store, like comments). It is NOT a new artifact type —
 * it's a lightweight signal the agent reads via check_feedback (a priority line,
 * ranked AFTER unanswered questions and AFTER freshly-rejected artifacts) or,
 * when no agent is live, via the composer's one-click resume-prompt (mirroring
 * ResumeQuestionsBanner). `servedByArtifactId` is set when the agent links a
 * fulfilling artifact — the UI reads it to show a served/unserved state.
 */
export const RequestIntentSchema = z.enum(["explain", "plan", "status"]);
export type RequestIntent = z.infer<typeof RequestIntentSchema>;

export const RequestSchema = z.object({
  id: z.string(),
  /** The human's free text (the fill-in for the preset, e.g. "the auth middleware"). */
  text: z.string().min(1),
  /** Which preset the human chose — drives the artifact type the agent serves with. */
  intent: RequestIntentSchema,
  createdAt: z.string().datetime(),
  /**
   * Set when the agent links a fulfilling artifact (via the present_* tools'
   * optional `servedRequestId` param). Absent = unserved (the agent still owes
   * a response). Optional for backward compatibility (project rule: all new
   * fields optional) — an old stored request without it loads unchanged.
   */
  servedByArtifactId: z.string().optional(),
  /**
   * #204 (code lens F1) — secret-scanner matches found in the request's `text`
   * at create time. A request is HUMAN-authored free text (the same risk as a
   * comment: a key pasted into the composer then flows into agent context via
   * check_feedback and lands on disk), so `FileStore.addRequest` scans and
   * persists the labels-only result here — pattern prefix + label (+ line),
   * NEVER the matched value. This closes the last human-text ingress that
   * bypassed the store-authoritative scan already covering comments (#160),
   * artifact content (#158), and render failures (#176). Optional for backward
   * compatibility (project rule: all new fields optional) — an old stored
   * request without it loads unchanged.
   */
  secretWarnings: z.array(SecretWarningSchema).optional(),
});
export type Request = z.infer<typeof RequestSchema>;

/** Human-readable phrasing of a request's intent — shared so the composer, the
 *  check_feedback delivery line, and the first-call obligations inventory all
 *  describe a request the same way (no drift). */
export function describeRequestIntent(intent: RequestIntent): string {
  switch (intent) {
    case "explain":
      return "explain how it works (present_explainer)";
    case "plan":
      return "plan it before building (present_plan / present_spec)";
    case "status":
      return "a status summary (present_debrief-style)";
  }
}
