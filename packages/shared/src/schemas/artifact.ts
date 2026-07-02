import { z } from "zod";
import {
  DecisionOptionBaseSchema,
  DecisionOptionConceptSchema,
  ResearchContentSchema,
  PlanContentSchema,
  SpecContentSchema,
  ReasoningContentSchema,
} from "./content-types.js";

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
  // "obsolete" — the agent moved on / the work was overcome by new information.
  // Distinct from rejected (human declined) and retracted (agent mistake): the
  // artifact was valid but the discussion overtook it. A terminal state, so it
  // drops out of "waiting for review".
  "obsolete",
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
  content: z.record(z.string(), z.unknown()),
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

/**
 * Y5 — named concept embedded directly on the option, hoisted from the
 * log_reasoning surface. PMF council: without a named concept at proposal
 * time, the ledger captures rejections as opaque strings ("considered:
 * 'use Redux'"), and the Y1 breadcrumb has nothing to expand into. Naming
 * the concept here makes EACH option a candidate ledger entry — when the
 * human rejects an option, we record the rejection against `concept.name`
 * (compact, comparable across projects) instead of the option's prose
 * description (project-specific, doesn't compound).
 *
 * Same shape as ReasoningConceptSchema in content-types.ts so the UI can
 * reuse the ConceptCallout component without translation. Optional —
 * existing call sites that don't supply concepts keep working.
 */
// C6b — stored shape aliases the shared base (content-types.ts); see the
// note there before diverging wire and stored shapes.
export const DecisionOptionContentSchema = DecisionOptionBaseSchema;

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
  /**
   * Y5 — named concept. Same shape as the option-level concept and the
   * reasoning-artifact concept, intentionally — UI reuses ConceptCallout
   * across all three. When this code change matches a rejected concept
   * across projects, the Y1 breadcrumb has something compact to compare
   * against; without it, preflight has only filePath + reasoning prose
   * to match against, which doesn't compound.
   */
  concept: DecisionOptionConceptSchema.optional(),
});

export type CodeChangeContent = z.infer<typeof CodeChangeContentSchema>;

/**
 * U2 — discriminated, validated artifact-content parser. Switches on
 * `artifact.type` and runs the matching Zod schema's `.safeParse`, returning
 * a typed payload OR a structured failure. This is the STRICT counterpart to
 * the renderer-facing `coerceArtifactContent` (which is lenient and never
 * fails): use this when a caller needs to know the content is well-formed
 * (validation, tooling), and the coercer when a renderer must show whatever
 * it can. On failure the parser returns `{ ok: false, error }` rather than
 * throwing.
 *
 * Falls back to ResearchContentSchema-style validation for `research`,
 * PlanContentSchema for `plan`, etc.
 */
type ParseResult<T> = { ok: true; data: T } | { ok: false; error: z.ZodError };

// D7 — SYNC. The old async form's lazy import cited a circular dep that is
// provably absent (this module already statically imports content-types
// values at the top). Async-only was the root cause of the server's
// content-cast plateau: every sync consumer cast instead of parsing.
export function parseArtifactContent(
  artifact: Artifact,
):
  | ParseResult<DecisionContent>
  | ParseResult<CodeChangeContent>
  | ParseResult<import("./content-types.js").ResearchContent>
  | ParseResult<import("./content-types.js").PlanContent>
  | ParseResult<import("./content-types.js").SpecContent>
  | ParseResult<import("./content-types.js").ReasoningContent> {
  const schema = (() => {
    switch (artifact.type) {
      case "decision":     return DecisionContentSchema;
      case "code_change":  return CodeChangeContentSchema;
      case "research":     return ResearchContentSchema;
      case "plan":         return PlanContentSchema;
      case "spec":         return SpecContentSchema;
      case "reasoning":    return ReasoningContentSchema;
    }
  })();
  const result = schema.safeParse(artifact.content);
  if (result.success) return { ok: true, data: result.data as any };
  return { ok: false, error: result.error };
}
