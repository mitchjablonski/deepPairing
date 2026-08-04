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
