import { z } from "zod";

/**
 * S5 — TaskHandle: a Task-shaped read view of a deepPairing artifact.
 *
 * Intentional future-proofing for the MCP Tasks primitive (see SEP-1686
 * + the 2026 MCP roadmap). When `@modelcontextprotocol/sdk` ships Tasks,
 * the present_* tools will return a Task referencing one of these handles
 * instead of a text content blob, and check_feedback becomes a thin
 * wrapper over `tasks/get`. Until then, the wire format stays text — but
 * every tool computes its result through this shape so the conversion is
 * a render-format flip, not a polling-model rewrite.
 *
 * Status enum mirrors what SEP-1686 specs:
 *   - working          tool called, nothing pending the human yet
 *   - input_required   human action awaited (review draft, choose option, verdict)
 *   - completed        human responded; result is in `response`
 *   - failed           artifact retracted, blocked by pre-flight, or tool error
 *   - cancelled        session ended / artifact superseded before completion
 */

export const TaskStatusSchema = z.enum([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskKindSchema = z.enum([
  "findings",
  "options",
  "spec",
  "plan",
  "code_change",
  "log_reasoning",
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskHandleSchema = z.object({
  /** Stable across the artifact's lifetime — typically the artifact id. */
  id: z.string().min(1),
  /** Which present_* tool produced this. Drives the future Task render. */
  taskKind: TaskKindSchema,
  status: TaskStatusSchema,
  /** The artifact this Task wraps. */
  artifactId: z.string().min(1),
  /**
   * Free-form response payload populated when status transitions to
   * `completed`. Shape varies by taskKind:
   *   - options:     { optionId, reasoning?, predictedOutcome?, confidence? }
   *   - plan:        { verdict: "approved" | "revised" | "rejected", feedback? }
   *   - findings/spec/code_change: { status: ArtifactStatus, comments?: ... }
   *   - log_reasoning: undefined (always completed on creation)
   */
  response: z.unknown().optional(),
  createdAt: z.string().datetime(),
  lastUpdatedAt: z.string().datetime(),
});
export type TaskHandle = z.infer<typeof TaskHandleSchema>;
