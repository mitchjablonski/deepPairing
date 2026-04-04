import { z } from "zod";

export const ArtifactTypeSchema = z.enum([
  "research",
  "plan",
  "decision",
  "code_change",
  "reasoning",
]);

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactStatusSchema = z.enum([
  "draft",
  "reviewing",
  "approved",
  "revised",
  "rejected",
  "superseded",
]);

export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: ArtifactTypeSchema,
  version: z.number().int().positive(),
  parentId: z.string().nullable(),
  title: z.string(),
  status: ArtifactStatusSchema,
  content: z.record(z.unknown()),
  agentReasoning: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
