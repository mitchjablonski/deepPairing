import { z } from "zod";
import { DecisionOptionBaseSchema } from "./content-types.js";

export const DecisionStakesSchema = z.enum(["low", "medium", "high"]);
export type DecisionStakes = z.infer<typeof DecisionStakesSchema>;

/**
 * Z5 — option-level concept, mirroring Y5's hoist into
 * DecisionOptionContentSchema (artifact.ts). Same field, two shapes
 * because we have a wire/event schema (this file) and a stored-content
 * schema (artifact.ts) that describe the same semantic object. Both
 * must carry concept or DecisionCard has to (option as any) it back —
 * which is exactly the regression the Z review flagged.
 */
// C6b — the wire shape IS the shared base (see content-types.ts). The Z5
// wire/stored split is preserved at the type level via the two exported
// names; the SHAPE is single-sourced so it can't drift again (DV1 added
// `visuals` to both copies by hand — the failure mode this ends).
export const DecisionOptionSchema = DecisionOptionBaseSchema;

export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionRequestSchema = z.object({
  decisionId: z.string(),
  context: z.string(),
  /** M1.1 — optional short question naming the fork (the card header). Full
   *  background stays in `context`. Absent → context is used as before. */
  title: z.string().optional(),
  options: z.array(DecisionOptionSchema).min(2).max(4),
  /**
   * How consequential is this decision? Agent sets this on architecturally
   * significant / hard-to-reverse choices. Drives the UI's visual weight on
   * the decision card (the "high/medium stakes" badge) so the human sees at a
   * glance which calls are load-bearing.
   */
  stakes: DecisionStakesSchema.optional(),
});

export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const DecisionConfidenceSchema = z.enum(["low", "medium", "high"]);
export type DecisionConfidence = z.infer<typeof DecisionConfidenceSchema>;

export const DecisionResponseSchema = z.object({
  optionId: z.string(),
  reasoning: z.string().optional(),
  /**
   * Legacy craft-development fields, retained OPTIONAL for backward compat so
   * decisions.json written before the calibration-loop cut (E3, #194) still
   * parse. No live surface captures these anymore — the prediction-capture
   * ritual was cut after 0/36 real high-stakes decisions ever recorded one.
   */
  confidence: DecisionConfidenceSchema.optional(),
  predictedOutcome: z.string().optional(),
});

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;


/**
 * #492 — the refusal a decision-resolve answers when the decision's backing
 * artifact was CLOSED (superseded by a newer version, retracted by the agent,
 * or marked obsolete): 409 `decision_closed`. Every field beyond `code` and
 * `currentStatus` is optional (backward-compatible). `supersededBy` names the
 * newer version so a stale card can link to it.
 */
export const DecisionClosedStatusSchema = z.enum(["superseded", "retracted", "obsolete"]);
export type DecisionClosedStatus = z.infer<typeof DecisionClosedStatusSchema>;

/**
 * #493 review — the ONE definition of "can this decision accept an answer?",
 * by its artifact's status. A decision in any of these states can't: it was
 * rejected or sent back (a verdict), replaced by a newer version, withdrawn,
 * or overtaken. Used both to refuse a late answer and to decide whether a
 * newer version is worth linking to (a non-answerable successor gets no link).
 */
export const DECISION_NON_ANSWERABLE_STATUSES = ["rejected", "revised", "superseded", "retracted", "obsolete"] as const;
export const DecisionNonAnswerableStatusSchema = z.enum(DECISION_NON_ANSWERABLE_STATUSES);
export type DecisionNonAnswerableStatus = z.infer<typeof DecisionNonAnswerableStatusSchema>;
export function decisionCanAcceptAnswer(status: string): boolean {
  return !(DECISION_NON_ANSWERABLE_STATUSES as readonly string[]).includes(status);
}
/** How to say, to you, what happened to a version that can't take an answer. */
export function nonAnswerableVerb(status: DecisionNonAnswerableStatus): string {
  switch (status) {
    case "rejected": return "rejected";
    case "revised": return "sent back for changes";
    case "superseded": return "replaced";
    case "retracted": return "withdrawn";
    default: return "closed";
  }
}

export const DecisionSupersededBySchema = z.object({
  artifactId: z.string(),
  decisionId: z.string().optional(),
});
export type DecisionSupersededBy = z.infer<typeof DecisionSupersededBySchema>;

export const DecisionClosedRefusalSchema = z.object({
  error: z.literal("decision_closed").optional(),
  code: z.literal("decision_closed"),
  currentStatus: DecisionClosedStatusSchema,
  decisionId: z.string().optional(),
  artifactId: z.string().optional(),
  supersededBy: DecisionSupersededBySchema.optional(),
  /** #493 review — the newest version was itself closed: no `supersededBy`
   *  link (nothing to answer), and this says why. */
  successorStatus: DecisionNonAnswerableStatusSchema.optional(),
  message: z.string().optional(),
});
export type DecisionClosedRefusal = z.infer<typeof DecisionClosedRefusalSchema>;
