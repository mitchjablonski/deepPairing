import { z } from "zod";
import { PlanVisualSchema } from "./content-types.js";

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
const DecisionOptionConceptSchema = z.object({
  name: z.string().min(1),
  oneLineExplanation: z.string().optional(),
});

export const DecisionOptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  effort: z.enum(["low", "medium", "high"]),
  risk: z.enum(["low", "medium", "high"]),
  recommendation: z.boolean(),
  concept: DecisionOptionConceptSchema.optional(),
  /**
   * DV1 — optional per-option visuals (Mermaid diagram / file map / annotated
   * code), reusing PlanVisualSchema so the whole render + comment stack applies.
   * Shown behind an expand-on-demand disclosure in each option card so the grid
   * stays scannable. Same field on DecisionOptionContentSchema (artifact.ts) —
   * the Z5 wire/stored split.
   */
  visuals: z.array(PlanVisualSchema).optional(),
});

export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionRequestSchema = z.object({
  decisionId: z.string(),
  context: z.string(),
  options: z.array(DecisionOptionSchema).min(2).max(4),
  /**
   * How consequential is this decision? Agent sets this on architecturally
   * significant / hard-to-reverse choices. When "high", the UI asks the
   * human for a prediction + confidence alongside their pick — the raw
   * material for calibration tracking later.
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
   * Optional craft-development fields — captured primarily on high-stakes
   * decisions. The UI prompts for these; the human can skip.
   */
  confidence: DecisionConfidenceSchema.optional(),
  /** What the human expects to happen as a result of this choice. */
  predictedOutcome: z.string().optional(),
});

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
