import { z } from "zod";

/**
 * #470 — one-proposal stance exceptions ("Allow this proposal once").
 *
 * Durable records here are deliberately NOT .strict(), so an older reader
 * tolerates a newer writer's extra keys. Every field here is OPTIONAL wherever it lands on an existing record
 * (Artifact, block-log entry, preflight trace), per the project's backward-
 * compatibility rule. Nothing in this file is authority: active allowances live
 * only in the daemon's memory (O1). These schemas describe the durable,
 * NON-authorizing traces an allowance leaves behind — the operation stamp on an
 * admitted artifact, and the receipt on the block-log entry. Receipts are not
 * tamper-evident and never name an authenticated person.
 */

/** The human's stance a block matched, compared exactly at grant and claim. */
export const StanceRefSchema = z.object({
  description: z.string(),
  concept: z.string().optional(),
  rejectedAt: z.string().optional(),
});
export type StanceRef = z.infer<typeof StanceRefSchema>;

/**
 * The EFFECTIVE proposal: exactly what an admitted call creates, after every
 * server-side derivation, minus ids the server mints (`art_`, `dec_`, `cmt_`).
 * `type` is a plain string here (validated against ArtifactTypeSchema where it
 * is used) so this module stays import-free of artifact.ts.
 */
export const ProposalSnapshotSchema = z.object({
  kind: z.enum(["create", "revise"]),
  type: z.string().min(1),
  title: z.string().min(1),
  content: z.record(z.string(), z.unknown()),
  agentReasoning: z.string().optional(),
  relatedArtifactIds: z.array(z.string()).optional(),
  feature: z.string().optional(),
  parentId: z.string().optional(),
  version: z.number().int().positive().optional(),
}).strict();
export type ProposalSnapshot = z.infer<typeof ProposalSnapshotSchema>;

/** The store facts a resolution read. Re-checked by the daemon at claim time. */
export const ProposalPreconditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("code_change_prior"),
    filePath: z.string(),
    /** The prior code_change that supplied `before`, or null when none did. */
    priorCodeChangeId: z.string().nullable(),
    /** sha256 of that prior's `after`, or null when there was no prior. */
    priorAfterHash: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal("revise_target"),
    targetId: z.string(),
    targetVersion: z.number().int(),
    targetStatus: z.string(),
    /** sha256 over every field a revision inherits from its target. */
    inheritedHash: z.string(),
  }).strict(),
]);
export type ProposalPrecondition = z.infer<typeof ProposalPreconditionSchema>;

export const StanceGrantOriginSchema = z.enum(["ui", "cli"]);
export type StanceGrantOrigin = z.infer<typeof StanceGrantOriginSchema>;

/** Receipt states shown to the human. `ended`/`expired` are derived on read. */
export const StanceAllowanceReceiptStateSchema = z.enum(["allowed", "used", "changed", "revoked", "ended", "expired"]);
export type StanceAllowanceReceiptState = z.infer<typeof StanceAllowanceReceiptStateSchema>;

/** The durable receipt on a block-log entry. Written only by the daemon. */
export const StanceAllowanceReceiptSchema = z.object({
  id: z.string(),
  /** Which door was used. Self-reported; labels, never authenticates. */
  grantedVia: StanceGrantOriginSchema,
  grantedAt: z.string(),
  reason: z.string(),
  ceilingAt: z.string(),
  state: StanceAllowanceReceiptStateSchema,
  artifactId: z.string().optional(),
  revokedAt: z.string().optional(),
  /** Set with `changed`: the new block recorded when the dependency moved. */
  supersededByBlockId: z.string().optional(),
});
export type StanceAllowanceReceipt = z.infer<typeof StanceAllowanceReceiptSchema>;

/**
 * The follow-ups an admitted operation owes, with every id minted BEFORE the
 * child is written, so a replay can finish them without inventing anything.
 */
export const AdmissionFollowUpsSchema = z.object({
  supersede: z.object({
    parentId: z.string(),
    /** The parent's status when the claim succeeded. A replay supersedes only
     *  from this status; any other (a human verdict since) is skipped. */
    fromStatus: z.string(),
    skipped: z.string().optional(),
  }).optional(),
  comment: z.object({ id: z.string(), artifactId: z.string(), content: z.string() }).optional(),
  decision: z.object({
    decisionId: z.string(),
    artifactId: z.string(),
    context: z.string(),
    title: z.string().optional(),
    options: z.array(z.unknown()),
    stakes: z.enum(["low", "medium", "high"]).optional(),
  }).optional(),
  planReview: z.boolean().optional(),
  /** The admitted call's preflight trace, persisted against the child. */
  trace: z.record(z.string(), z.unknown()).optional(),
});
export type AdmissionFollowUps = z.infer<typeof AdmissionFollowUpsSchema>;

/**
 * The operation stamp on an admitted child artifact. Written in the same flush
 * as the child. NON-AUTHORIZING: a replay reads it to report and finish an
 * operation; it never creates, admits or arms anything.
 */
export const ArtifactAdmissionSchema = z.object({
  operationId: z.string(),
  callFingerprint: z.string(),
  effectiveDigest: z.string(),
  kind: z.enum(["create", "revise"]),
  exceptionIds: z.array(z.string()),
  grantedVia: StanceGrantOriginSchema,
  followUps: AdmissionFollowUpsSchema,
  completedAt: z.string().optional(),
});
export type ArtifactAdmission = z.infer<typeof ArtifactAdmissionSchema>;

/** The `exception` summary on an admitted artifact's preflight trace. */
export const PreflightTraceExceptionSchema = z.object({
  allowanceIds: z.array(z.string()),
  grantedVia: StanceGrantOriginSchema,
  stances: z.array(z.string()),
});
