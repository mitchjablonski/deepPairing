import { z } from "zod";

/**
 * Y1' — preflight trace.
 *
 * Sidecar record of WHAT the agent's present_* tool consulted before it
 * created an artifact. Stored separately from Artifact (artifacts are
 * immutable + versioned via parentId; the trace describes a one-time
 * consult event, not artifact content) — see council architecture
 * round-2 review.
 *
 * The whole point: make the silent moat felt. Today the user only learns
 * that the philosophy ledger exists when something gets BLOCKED. Most
 * sessions never see a block, so the moat is invisible. The trace lets
 * every artifact carry a one-line "Cross-checked your N prior stances"
 * footer, expandable to show which concepts were weighed.
 *
 * Schema design:
 * - `consideredCount` is the headline number (drives the breadcrumb copy).
 * - `consideredConcepts` is the expand-on-click detail. Capped at 20 to
 *   keep the JSON small; older items drop tail-first if you somehow have
 *   more rejected approaches than that.
 * - `nearMisses` are admitted-but-watch-this signals the validator can
 *   produce when concept tokens partially match a past rejection.
 *   Optional, may be empty even when the trace is recorded.
 * - `block` is set ONLY for blocked traces (decision === "blocked"). The
 *   schema allows it on either decision so a future "soft-block / warn"
 *   tier doesn't need a migration.
 */
export const PreflightConsideredConceptSchema = z.object({
  /** "session" = user-rejected this session, "team" = .deeppairing/team.json. */
  source: z.enum(["session", "team"]),
  /** The named concept the agent's proposal was weighed against. */
  concept: z.string().min(1),
  /** The user's reason for rejecting (or the team rationale). May be empty. */
  reason: z.string().optional(),
});

export const PreflightNearMissSchema = z.object({
  /**
   * "session"/"team" — a LOCAL near-miss (partial token overlap with a stance
   * that CAN hard-block here). "global" — a cross-project ADVISORY match: the
   * user avoided this concept in another project, surfaced as a nudge that
   * NEVER hard-blocks (advisory-first). The `project` field names where.
   */
  source: z.enum(["session", "team", "global"]),
  concept: z.string().min(1),
  reason: z.string().optional(),
  /** For source==="global": the project basename where the stance was avoided. */
  project: z.string().optional(),
  /**
   * Why this counts as "almost flagged" — short human-readable note. The
   * UI surfaces it as: "Your past stance on `${concept}` is adjacent."
   */
  why: z.string().optional(),
});

export const PreflightBlockSummarySchema = z.object({
  source: z.enum(["session", "team"]),
  concept: z.string().optional(),
  reason: z.string().optional(),
  via: z.enum(["surface", "concept", "avoid", "require"]).optional(),
});

export const PreflightTraceSchema = z.object({
  /** Schema version — bump on breaking shape change. */
  version: z.literal(1),
  /** ISO timestamp of when preflight ran. */
  at: z.string(),
  /** The artifact this trace belongs to. */
  artifactId: z.string(),
  /** Which present_* tool the agent called. */
  toolName: z.string(),
  /** "admitted" — passed; "blocked" — refused. */
  decision: z.enum(["admitted", "blocked"]),
  /** Total number of stances the validator weighed. */
  consideredCount: z.number().int().min(0),
  /** Capped detail list (top 20). */
  consideredConcepts: z.array(PreflightConsideredConceptSchema),
  /** Concepts that partially matched but didn't block. May be empty. */
  nearMisses: z.array(PreflightNearMissSchema),
  /** Set only when decision === "blocked". */
  block: PreflightBlockSummarySchema.optional(),
});

export type PreflightTrace = z.infer<typeof PreflightTraceSchema>;
export type PreflightConsideredConcept = z.infer<typeof PreflightConsideredConceptSchema>;
export type PreflightNearMiss = z.infer<typeof PreflightNearMissSchema>;
