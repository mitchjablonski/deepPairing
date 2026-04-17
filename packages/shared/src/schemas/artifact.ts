import { z } from "zod";

export const ArtifactTypeSchema = z.enum([
  "research",
  "plan",
  "decision",
  "code_change",
  "reasoning",
  "spec",
]);

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactStatusSchema = z.enum([
  "draft",
  "reviewing",
  "approved",
  "revised",
  "rejected",
  "superseded",
  "retracted",
]);

export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ArtifactStatusHistoryEntrySchema = z.object({
  status: ArtifactStatusSchema,
  at: z.string().datetime(),
});
export type ArtifactStatusHistoryEntry = z.infer<typeof ArtifactStatusHistoryEntrySchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: ArtifactTypeSchema,
  version: z.number().int().positive(),
  parentId: z.string().nullable(),
  title: z.string(),
  status: ArtifactStatusSchema,
  /**
   * Timestamped trail of status transitions. Optional for backward
   * compatibility with older sessions — replay falls back to
   * createdAt/updatedAt when absent.
   */
  statusHistory: z.array(ArtifactStatusHistoryEntrySchema).optional(),
  content: z.record(z.unknown()),
  agentReasoning: z.string().nullable(),
  relatedArtifactIds: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

// --- Typed content interfaces for artifact types not covered by content-types.ts ---

export interface DecisionContent {
  context: string;
  options: Array<{
    id: string;
    title: string;
    description: string;
    pros: string[];
    cons: string[];
    effort: "low" | "medium" | "high";
    risk: "low" | "medium" | "high";
    recommendation: boolean;
  }>;
  decisionId: string;
}

export interface CodeChangeContent {
  filePath: string;
  changeType: "create" | "modify" | "delete";
  before: string;
  after: string;
  reasoning: string;
  confidence?: "low" | "medium" | "high";
}

/** Helper to cast artifact content to a typed interface */
export function getTypedContent<T>(artifact: Artifact): T {
  return artifact.content as T;
}
