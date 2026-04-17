import { z } from "zod";
import { EvidenceInputSchema } from "./evidence.js";

export const FindingSchema = z.object({
  category: z.string(),
  title: z.string().optional(),
  detail: z.string(),
  evidence: z.union([z.string(), z.array(EvidenceInputSchema)]),
  significance: z.enum(["low", "medium", "high"]),
  impact: z.string().optional().describe("What happens if this is not addressed"),
  recommendation: z.string().optional().describe("What should be done"),
  relatedFindings: z.array(z.string()).optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const ResearchContentSchema = z.object({
  summary: z.string(),
  findings: z.array(FindingSchema),
  openQuestions: z.array(z.string()).optional(),
});

export type ResearchContent = z.infer<typeof ResearchContentSchema>;

export const FileChangeSchema = z.object({
  filePath: z.string(),
  description: z.string().optional(),
  changeType: z.enum(["create", "modify", "delete"]).optional(),
});

export type FileChange = z.infer<typeof FileChangeSchema>;

export const PlanStepSchema = z.object({
  description: z.string(),
  reasoning: z.string(),
  files: z.union([z.array(z.string()), z.array(FileChangeSchema)]),
  motivatedBy: z.array(z.string()).optional().describe("Finding titles that led to this step"),
  preview: z
    .object({
      before: z.string(),
      after: z.string(),
      filePath: z.string(),
    })
    .optional()
    .describe("Before/after code preview"),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanContentSchema = z.object({
  steps: z.array(PlanStepSchema),
  estimatedChanges: z.number(),
});

export type PlanContent = z.infer<typeof PlanContentSchema>;

// --- Reasoning (the "show your work" artifact) ---

/** A named concept the agent is applying — the pairing-learning hook. */
export const ReasoningConceptSchema = z.object({
  name: z.string().describe("The concept name (e.g. 'dependency inversion', 'optimistic UI', 'debounce vs throttle')"),
  oneLineExplanation: z
    .string()
    .optional()
    .describe("One-sentence plain-English explanation for a developer who may not know the concept"),
});

export type ReasoningConcept = z.infer<typeof ReasoningConceptSchema>;

/** How this reasoning step connects to another artifact. */
export const ReasoningRelationSchema = z.object({
  artifactId: z.string(),
  kind: z.enum(["elaborates", "answers", "supersedes"]),
});

export type ReasoningRelation = z.infer<typeof ReasoningRelationSchema>;

export const ReasoningContentSchema = z.object({
  action: z.string().describe("What you're about to do, in plain English"),
  reasoning: z.string().describe("Why this approach"),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  /** Legacy: flat strings. New agents prefer alternativeDetails. */
  alternativesConsidered: z.array(z.string()).optional(),
  /** Rejected alternatives with structured reasons. */
  alternativeDetails: z
    .array(
      z.object({
        title: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  /**
   * The named concept the agent is applying. THIS IS THE PAIRING LEVER —
   * when the agent surfaces the concept by name (instead of just applying
   * it silently), the human learns the pattern, not just the fix.
   */
  concept: ReasoningConceptSchema.optional(),
  /** Files / lines that motivated this reasoning step. */
  evidence: z.array(EvidenceInputSchema).optional(),
  /** Back-link to another artifact this reasoning elaborates / answers. */
  relatesTo: ReasoningRelationSchema.optional(),
});

export type ReasoningContent = z.infer<typeof ReasoningContentSchema>;
