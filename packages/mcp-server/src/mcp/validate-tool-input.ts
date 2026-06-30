/**
 * Validate `present_*` tool input against the shared content schemas BEFORE
 * the artifact is persisted. Returns either { ok: true, data } or
 * { ok: false, error } where `error` is the agent-facing tool-result content
 * already shaped — the caller just returns it.
 *
 * Why this exists: the `present_findings` field-bug. The agent passed
 * `findings: "<a long string>"` instead of `findings: [{...}, {...}]`.
 * The handler did `Array.isArray(args?.findings) ? args.findings : []` for
 * the proposal-extraction path but then persisted the raw `args.findings`
 * string anyway. The UI later iterated the string as if it were an array
 * (1610 character "findings"), threw inside ResearchArtifact, and the
 * ErrorBoundary blanked the whole panel. The agent had no idea anything
 * was wrong because the tool returned success.
 *
 * Validation happens HERE so:
 *   - The bad shape never lands on disk.
 *   - The agent gets a structured INPUT_VALIDATION_FAILED error naming
 *     the exact path that was wrong, what was expected, and a minimal
 *     correct example to retry from.
 *   - The error format mirrors REJECTED_APPROACH_BLOCKED so the LLM's
 *     retry logic treats it the same way.
 */
import { z } from "zod";
import {
  ResearchContentSchema,
  SpecContentSchema,
  PlanContentSchema,
  DecisionContentSchema,
  CodeChangeContentSchema,
  ReasoningContentSchema,
  PlanVisualSchema,
} from "@deeppairing/shared";

export type ToolErrorResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  /**
   * IV10 — structured machine-readable error metadata. MCP clients can
   * branch on `_meta.code` / `_meta.retryable` instead of string-matching
   * the prose in content[0].text. Future-proofs the protocol surface
   * without changing the existing agent-visible contract.
   */
  _meta?: {
    code?: string;
    retryable?: boolean;
  };
};

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolErrorResponse };

/**
 * Format a Zod issue list into a single agent-facing message naming each
 * bad path, what was expected, and an inline example of the correct shape.
 * Mirrors the REJECTED_APPROACH_BLOCKED tone so the LLM's "I should retry
 * with a fixed input" reflex kicks in.
 */
function formatValidationError(
  toolName: string,
  err: z.ZodError,
  example: string,
): ToolErrorResponse {
  const issues = err.issues.slice(0, 5).map((i) => {
    const path = i.path.length ? i.path.join(".") : "(root)";
    return `  • ${path}: ${i.message}`;
  });
  const more = err.issues.length > 5 ? `\n  • …and ${err.issues.length - 5} more` : "";
  const text =
    `INPUT_VALIDATION_FAILED: ${toolName} refused — your input doesn't match the schema:\n` +
    issues.join("\n") + more + "\n\n" +
    `Expected shape (minimal example):\n${example}\n\n` +
    `Fix the input and call ${toolName} again. The artifact was NOT created.`;
  return {
    content: [{ type: "text", text }],
    isError: true as const,
    // IV10 — machine-readable code for future MCP clients. Same string
    // INPUT_VALIDATION_FAILED that's in the text body, but lifted into
    // _meta so clients can branch without parsing prose.
    _meta: { code: "INPUT_VALIDATION_FAILED", retryable: true },
  };
}

// Minimal correct-shape examples per tool. Kept short — the goal is to
// jog the LLM's memory, not to inline the full schema doc.
const EXAMPLE_FINDINGS = `{
  "title": "Auth audit",
  "summary": "Two issues in auth.ts",
  "findings": [
    {
      "category": "security",
      "title": "Weak password hash",
      "detail": "bcrypt rounds=4 is too low",
      "evidence": "auth.ts L23 uses bcrypt.hash(pw, 4)",
      "significance": "high",
      "recommendation": "raise to 12+"
    }
  ]
}`;

const EXAMPLE_OPTIONS = `{
  "context": "Which cache layer?",
  "options": [
    { "id": "a", "title": "Redis", "description": "...", "pros": ["fast"],
      "cons": ["another service"], "effort": "medium", "risk": "low",
      "recommendation": true,
      "concept": { "name": "external cache service",
        "oneLineExplanation": "in-process is faster but loses on multi-instance" } },
    { "id": "b", "title": "In-memory LRU", "description": "...", "pros": ["simple"],
      "cons": ["per-instance"], "effort": "low", "risk": "medium",
      "recommendation": false,
      "concept": { "name": "in-process LRU",
        "oneLineExplanation": "no network hop; each instance keeps its own copy" } }
  ]
}`;

const EXAMPLE_SPEC = `{
  "title": "Rate limit auth endpoints",
  "objective": "Block credential stuffing",
  "requirements": [
    {
      "id": "REQ-1",
      "statement": "Limit /login to 5 attempts/min per IP",
      "rationale": "Slows brute-force without harming real users",
      "acceptanceCriteria": ["6th attempt within 60s returns 429"]
    }
  ]
}`;

const EXAMPLE_PLAN = `{
  "title": "Add rate limiting",
  "estimatedChanges": 3,
  "steps": [
    { "description": "Install limiter middleware", "reasoning": "...", "files": ["packages/api/middleware/limit.ts"] }
  ]
}`;

const EXAMPLE_CODE_CHANGE = `{
  "filePath": "packages/api/auth.ts",
  "changeType": "modify",
  "before": "bcrypt.hash(pw, 4)",
  "after":  "bcrypt.hash(pw, 12)",
  "reasoning": "Raise cost factor; rounds=4 is brute-forceable in <1 day",
  "concept": { "name": "password-hash work factor tuning",
    "oneLineExplanation": "the cost should make brute-force impractical at today's hardware" }
}`;

const EXAMPLE_REASONING = `{
  "action": "extract DI for the cache",
  "reasoning": "tests need to swap Redis for an in-memory fake",
  "concept": { "name": "dependency inversion",
    "oneLineExplanation": "depend on an interface, not a concrete impl" }
}`;

// Per-tool input adapters: pull the relevant args fields, run the matching
// content schema. The schemas live in @deeppairing/shared and are already
// the source of truth for what the daemon stores.

export function validatePresentFindingsInput(args: any): ValidationResult<z.infer<typeof ResearchContentSchema>> {
  const result = ResearchContentSchema.safeParse({
    summary: args?.summary,
    findings: args?.findings,
    openQuestions: args?.openQuestions,
  });
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: formatValidationError("present_findings", result.error, EXAMPLE_FINDINGS) };
}

const PresentOptionsInputSchema = z.object({
  context: z.string().min(1),
  options: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    pros: z.array(z.string()),
    cons: z.array(z.string()),
    effort: z.enum(["low", "medium", "high"]),
    risk: z.enum(["low", "medium", "high"]),
    recommendation: z.boolean(),
    // Y5 — name the underlying pattern so rejections compound across
    // projects. Optional for back-compat, but the description in
    // ListTools (server.ts) actively encourages it.
    concept: z.object({
      name: z.string().min(1),
      oneLineExplanation: z.string().optional(),
    }).optional(),
    // DV1 — optional per-option visuals (e.g. a Mermaid diagram of this option's
    // architecture). id is optional on input — coerceOption assigns a stable
    // option-scoped one if omitted, so the agent can just send {kind, source}.
    visuals: z.array(PlanVisualSchema.extend({ id: z.string().optional() })).optional(),
  })).min(2).max(4),
  stakes: z.enum(["low", "medium", "high"]).optional(),
});

export function validatePresentOptionsInput(args: any): ValidationResult<z.infer<typeof PresentOptionsInputSchema>> {
  const result = PresentOptionsInputSchema.safeParse(args);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: formatValidationError("present_options", result.error, EXAMPLE_OPTIONS) };
}

export function validatePresentSpecInput(args: any): ValidationResult<z.infer<typeof SpecContentSchema> & { title: string }> {
  // Spec needs a title (artifact-level) plus the content fields.
  const titleParse = z.object({ title: z.string().min(1) }).safeParse(args);
  if (!titleParse.success) {
    return { ok: false, error: formatValidationError("present_spec", titleParse.error, EXAMPLE_SPEC) };
  }
  const contentParse = SpecContentSchema.safeParse({
    objective: args?.objective,
    context: args?.context,
    requirements: args?.requirements,
    design: args?.design,
    tasks: args?.tasks,
    openQuestions: args?.openQuestions,
    visuals: args?.visuals,
  });
  if (!contentParse.success) {
    return { ok: false, error: formatValidationError("present_spec", contentParse.error, EXAMPLE_SPEC) };
  }
  return { ok: true, data: { title: titleParse.data.title, ...contentParse.data } };
}

export function validatePresentPlanInput(args: any): ValidationResult<z.infer<typeof PlanContentSchema> & { title: string }> {
  const titleParse = z.object({ title: z.string().min(1) }).safeParse(args);
  if (!titleParse.success) {
    return { ok: false, error: formatValidationError("present_plan", titleParse.error, EXAMPLE_PLAN) };
  }
  const contentParse = PlanContentSchema.safeParse({
    steps: args?.steps,
    estimatedChanges: args?.estimatedChanges,
    visuals: args?.visuals,
  });
  if (!contentParse.success) {
    return { ok: false, error: formatValidationError("present_plan", contentParse.error, EXAMPLE_PLAN) };
  }
  return { ok: true, data: { title: titleParse.data.title, ...contentParse.data } };
}

export function validatePresentCodeChangeInput(args: any): ValidationResult<z.infer<typeof CodeChangeContentSchema>> {
  const result = CodeChangeContentSchema.safeParse({
    filePath: args?.filePath,
    changeType: args?.changeType,
    before: args?.before ?? "",
    after: args?.after ?? "",
    reasoning: args?.reasoning,
    confidence: args?.confidence,
    // Y5 — pass the agent-supplied concept through so the artifact carries it.
    concept: args?.concept,
  });
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: formatValidationError("present_code_change", result.error, EXAMPLE_CODE_CHANGE) };
}

export function validateLogReasoningInput(args: any): ValidationResult<z.infer<typeof ReasoningContentSchema>> {
  const result = ReasoningContentSchema.safeParse({
    action: args?.action,
    reasoning: args?.reasoning,
    concept: args?.concept,
    evidence: args?.evidence,
    relatesTo: args?.relatesTo,
    alternativesConsidered: args?.alternativesConsidered,
    alternativeDetails: args?.alternativeDetails,
    confidence: args?.confidence,
  });
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: formatValidationError("log_reasoning", result.error, EXAMPLE_REASONING) };
}

// `decision` artifacts are constructed server-side from present_options
// args; the validator above already enforces the option shape, so a
// separate decision-content validator isn't needed at the tool boundary.
// Kept here for completeness if a future tool persists decision content
// directly.
export const _decisionContentSchemaForReference = DecisionContentSchema;
