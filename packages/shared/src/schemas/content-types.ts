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
