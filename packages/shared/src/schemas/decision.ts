import { z } from "zod";

export const DecisionOptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  effort: z.enum(["low", "medium", "high"]),
  risk: z.enum(["low", "medium", "high"]),
  recommendation: z.boolean(),
});

export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionRequestSchema = z.object({
  decisionId: z.string(),
  context: z.string(),
  options: z.array(DecisionOptionSchema).min(2).max(4),
});

export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const DecisionResponseSchema = z.object({
  optionId: z.string(),
  reasoning: z.string().optional(),
});

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
