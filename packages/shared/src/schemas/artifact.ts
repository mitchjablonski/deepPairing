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

// --- Typed content schemas for artifact types not in content-types.ts ---
// U2 — these are now real Zod schemas (previously TypeScript-only
// interfaces), so the discriminated parseArtifactContent below can
// validate at the boundary instead of trusting the upstream `as T`.

export const DecisionOptionContentSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  effort: z.enum(["low", "medium", "high"]),
  risk: z.enum(["low", "medium", "high"]),
  recommendation: z.boolean(),
});

export const DecisionContentSchema = z.object({
  context: z.string(),
  options: z.array(DecisionOptionContentSchema),
  decisionId: z.string(),
  /** How consequential this decision is. Only "high" triggers prediction capture. */
  stakes: z.enum(["low", "medium", "high"]).optional(),
});

export type DecisionContent = z.infer<typeof DecisionContentSchema>;

export const CodeChangeContentSchema = z.object({
  filePath: z.string(),
  changeType: z.enum(["create", "modify", "delete"]),
  before: z.string(),
  after: z.string(),
  reasoning: z.string(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
});

export type CodeChangeContent = z.infer<typeof CodeChangeContentSchema>;

/**
 * Helper to cast artifact content to a typed interface.
 *
 * @deprecated U2 — this is an unchecked `as T` cast and bypasses Zod's
 * source-of-truth guarantee. Prefer `parseArtifactContent(artifact)` for
 * a discriminated, validated payload. Kept here because dozens of web
 * components still use it; migrate gradually.
 */
export function getTypedContent<T>(artifact: Artifact): T {
  return artifact.content as T;
}

/**
 * U2 — discriminated, validated artifact-content parser. Switches on
 * `artifact.type` and runs the matching Zod schema's `.safeParse` so the
 * caller gets a typed payload OR a structured failure (instead of a
 * silent type lie like `getTypedContent` produces). On failure the
 * parser returns `{ ok: false, error }` rather than throwing — every
 * call site already runs in render, where a throw would crash the UI.
 *
 * Falls back to ResearchContentSchema-style validation for `research`,
 * PlanContentSchema for `plan`, etc., importing lazily so this module
 * doesn't grow a circular dep on content-types.
 */
type ParseResult<T> = { ok: true; data: T } | { ok: false; error: z.ZodError };

export async function parseArtifactContent(
  artifact: Artifact,
): Promise<
  | ParseResult<DecisionContent>
  | ParseResult<CodeChangeContent>
  | ParseResult<import("./content-types.js").ResearchContent>
  | ParseResult<import("./content-types.js").PlanContent>
  | ParseResult<import("./content-types.js").SpecContent>
  | ParseResult<import("./content-types.js").ReasoningContent>
> {
  const ct = await import("./content-types.js");
  const schema = (() => {
    switch (artifact.type) {
      case "decision":     return DecisionContentSchema;
      case "code_change":  return CodeChangeContentSchema;
      case "research":     return ct.ResearchContentSchema;
      case "plan":         return ct.PlanContentSchema;
      case "spec":         return ct.SpecContentSchema;
      case "reasoning":    return ct.ReasoningContentSchema;
    }
  })();
  const result = schema.safeParse(artifact.content);
  if (result.success) return { ok: true, data: result.data as any };
  return { ok: false, error: result.error };
}
