/**
 * U2 — Zod schemas for the public HTTP routes' request bodies.
 *
 * Pre-U2 routes did `const body = await c.req.json()` and then ran ad-hoc
 * `typeof` guards: missing fields silently became `undefined`, wrong-type
 * fields slipped through to the store, and an empty body could crash a
 * `body.foo.bar` access deeper in the handler. The code-quality reviewer
 * flagged this as one of the three highest-leverage findings.
 *
 * Every schema here is the boundary contract for one route. The route uses
 * `safeParse` and returns 400 with the Zod issue list on failure — the
 * frontend's safeFetch wraps that into an ApiError → toast.
 *
 * Optional fields stay optional so older clients keep working through a
 * schema bump. `.passthrough()` is deliberately NOT used: unknown fields
 * mean the client has drifted from the contract and we want to know.
 */
import { z } from "zod";

// POST /api/comments — submit a comment from the web UI.
export const CommentBodySchema = z.object({
  artifactId: z.string().min(1),
  content: z.string().min(1),
  /** Optional target metadata: line/finding/evidence/step/sectionId,
   *  shape varies by the artifact's renderer. Validated as a record so we
   *  don't have to enumerate every renderer's anchor strategy here. */
  target: z.record(z.string(), z.unknown()).optional(),
  intent: z.enum(["comment", "question", "suggestion"]).optional(),
  parentCommentId: z.string().nullable().optional(),
});
export type CommentBody = z.infer<typeof CommentBodySchema>;

// POST /api/decisions/:decisionId — resolve a decision from the web UI.
export const DecisionResolveBodySchema = z.object({
  optionId: z.string().min(1),
  reasoning: z.string().optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  predictedOutcome: z.string().optional(),
});
export type DecisionResolveBody = z.infer<typeof DecisionResolveBodySchema>;

// POST /api/artifacts/:artifactId/status — approve / revise / reject / obsolete
// ("obsolete" = dismissed as overcome by new information).
export const StatusUpdateBodySchema = z.object({
  status: z.enum(["approved", "revised", "rejected", "obsolete"]),
  feedback: z.string().optional(),
  /**
   * On reject, the human-named pattern being rejected — the cross-project
   * ledger key. Optional: when absent the server falls back to the agent's
   * named concept, then the artifact title (legacy behavior). Naming it
   * explicitly is what lets a future paraphrase get caught across projects.
   */
  concept: z.string().optional(),
});
export type StatusUpdateBody = z.infer<typeof StatusUpdateBodySchema>;

// POST /api/artifacts/:artifactId/rename
export const RenameBodySchema = z.object({
  title: z.string().min(1),
});
export type RenameBody = z.infer<typeof RenameBodySchema>;

// POST /api/preferences — autonomy level + future per-session prefs.
export const PreferenceBodySchema = z.object({
  autonomyLevel: z.enum(["supervised", "balanced", "autonomous"]).optional(),
});
export type PreferenceBody = z.infer<typeof PreferenceBodySchema>;

// POST /api/retrospectives — capture verdict on a past prediction.
export const RetrospectiveBodySchema = z.object({
  decisionId: z.string().min(1),
  verdict: z.enum(["right", "wrong", "mixed"]),
  note: z.string().max(2000).optional(),
});
export type RetrospectiveBody = z.infer<typeof RetrospectiveBodySchema>;

// POST /api/prompts — save a repair prompt for a decision.
export const PromptBodySchema = z.object({
  content: z.string().min(1),
  decisionId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type PromptBody = z.infer<typeof PromptBodySchema>;

/**
 * Tiny helper: format a ZodError as a human-readable error payload for the
 * 400 response. The frontend's ApiError currently only surfaces `message`
 * and `code`, so we collapse multiple issues into one message; the issues
 * array is included for richer future UIs without changing the shape.
 */
export function formatZodIssues(err: z.ZodError): { error: string; code: string; issues: Array<{ path: string; message: string }> } {
  const issues = err.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
  // noUncheckedIndexedAccess — ZodError.issues is never empty when this is
  // called, but the type can't know; the fallback keeps the message honest
  // rather than asserting.
  const first = issues[0] ?? { path: "(root)", message: "invalid input" };
  const summary = issues.length === 1
    ? `${first.path}: ${first.message}`
    : `${issues.length} validation errors (first: ${first.path}: ${first.message})`;
  return { error: summary, code: "validation_error", issues };
}
