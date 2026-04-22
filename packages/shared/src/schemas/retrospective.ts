import { z } from "zod";

/**
 * P2 — calibration retrospective.
 *
 * Captured AFTER a prediction landed in a past decision: the user looks back
 * and says whether their prediction actually played out. Closes the loop on
 * the calibration mechanic — predictions are only useful if we eventually
 * compare them to reality.
 *
 * Stored in the session that owns the original decision (not the session
 * where the retrospective is made), so the prediction + retrospective sit
 * together.
 */

export const RetrospectiveVerdictSchema = z.enum(["right", "wrong", "mixed"]);
export type RetrospectiveVerdict = z.infer<typeof RetrospectiveVerdictSchema>;

export const RetrospectiveSchema = z.object({
  id: z.string().min(1),
  /** The decisionId this retrospective targets. */
  decisionId: z.string().min(1),
  verdict: RetrospectiveVerdictSchema,
  /** Optional note: what actually happened. Learning material. */
  note: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type Retrospective = z.infer<typeof RetrospectiveSchema>;

export const CreateRetrospectiveRequestSchema = z.object({
  decisionId: z.string().min(1),
  verdict: RetrospectiveVerdictSchema,
  note: z.string().max(2000).optional(),
});
export type CreateRetrospectiveRequest = z.infer<typeof CreateRetrospectiveRequestSchema>;
