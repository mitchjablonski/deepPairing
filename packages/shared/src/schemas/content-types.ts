import { z } from "zod";
import { EvidenceInputSchema } from "./evidence.js";

export const FindingSeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingSchema = z.object({
  category: z.string(),
  title: z.string().optional(),
  detail: z.string(),
  /** Optional: high-level architectural findings sometimes have no code
   *  evidence to attach, and that's fine. The structural validator just
   *  needs to ensure findings is an array of objects, not a string. */
  evidence: z.union([z.string(), z.array(EvidenceInputSchema)]).optional(),
  /** How interesting / note-worthy — signals whether this belongs in the session at all. */
  significance: z.enum(["low", "medium", "high"]).describe("How note-worthy this finding is"),
  /**
   * Risk level for prioritization ("if we don't address this, how bad?").
   * Distinct from significance. Helps the developer know what to learn from
   * first. Optional so older sessions remain valid.
   */
  severity: FindingSeveritySchema.optional()
    .describe("Risk level if unaddressed — helps the human prioritize what to study first. Distinct from significance."),
  /**
   * How confident the agent is in this finding. The `present_findings` tool
   * accepts it and the UI renders a confidence badge, so it must be modelled
   * here — otherwise the non-strict validation boundary silently strips it
   * before the artifact is persisted. Optional for back-compat.
   */
  confidence: z.enum(["low", "medium", "high"]).optional().describe("How confident are you in this finding?"),
  impact: z.string().optional().describe("What happens if this is not addressed"),
  recommendation: z.string().optional().describe("What should be done"),
  relatedFindings: z.array(z.string()).optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const ResearchContentSchema = z.object({
  summary: z.string(),
  findings: z.array(FindingSchema),
  openQuestions: z.array(z.string()).optional(),
});

export type ResearchContent = z.infer<typeof ResearchContentSchema>;

export const FileChangeSchema = z.object({
  filePath: z.string(),
  description: z.string().optional(),
  changeType: z.enum(["create", "modify", "delete"]).optional(),
});

export type FileChange = z.infer<typeof FileChangeSchema>;

/** A files field shared by plan steps and their conditional branches:
 *  either a list of paths or a list of structured FileChange entries. */
const PlanFilesSchema = z.union([z.array(z.string()), z.array(FileChangeSchema)]);

/** One conditional branch of a plan step (executes when the step's
 *  `condition` is met). Mirrors the `branches` shape the present_plan tool
 *  accepts; deliberately not recursive (branches don't nest). */
export const PlanBranchSchema = z.object({
  description: z.string(),
  reasoning: z.string(),
  files: PlanFilesSchema.optional(),
});

export type PlanBranch = z.infer<typeof PlanBranchSchema>;

export const PlanStepSchema = z.object({
  description: z.string(),
  reasoning: z.string(),
  /** Optional: not every plan step touches files (e.g. "run tests",
   *  "review the design"). The structural validator only needs files to
   *  be an array of strings/FileChange when present. */
  files: PlanFilesSchema.optional(),
  motivatedBy: z.array(z.string()).optional().describe("Finding titles that led to this step"),
  preview: z
    .object({
      before: z.string(),
      after: z.string(),
      filePath: z.string(),
    })
    .optional()
    .describe("Before/after code preview"),
  /**
   * Conditional-branch fields the `present_plan` tool accepts and the plan
   * renderer displays. Modelled here so the non-strict validation boundary
   * stops stripping them before the artifact is persisted. Optional for
   * back-compat.
   */
  condition: z.string().optional().describe("Condition that turns this step into a conditional branch"),
  branches: z.array(PlanBranchSchema).optional().describe("Sub-steps that execute if the condition is met"),
  /**
   * D10 (H2) — joint execution tracking. After the human approves a plan the
   * build phase was the longest dead-air stretch in the session: the agent
   * worked silently until a code_change appeared. The agent now marks steps
   * via update_plan_progress and the UI renders a live "Step 3 of 7" strip.
   * Optional for back-compat (absent = execution not tracked).
   */
  status: z.enum(["pending", "in_progress", "done", "skipped"]).optional()
    .describe("Execution status, updated by the agent via update_plan_progress"),
  statusNote: z.string().optional()
    .describe("One-line note shown beside the step (e.g. why it was skipped)"),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

/** One planned file operation in a `file_map` visual. */
export const PlanVisualFileSchema = z.object({
  path: z.string(),
  change: z.enum(["create", "modify", "delete"]).optional(),
  note: z.string().optional(),
});

export type PlanVisualFile = z.infer<typeof PlanVisualFileSchema>;

/** One line-anchored annotation on an `annotated_code` visual — the agent
 *  pinning an explanation to a specific line ("this is the line that changes,
 *  and here's why"). `line` is the ABSOLUTE line number shown in the gutter
 *  (i.e. within [lineStart, lineStart + lines - 1]). */
export const PlanVisualAnnotationSchema = z.object({
  line: z.number(),
  note: z.string(),
  /** Semantic tag for styling the marker; purely presentational. */
  kind: z.enum(["add", "change", "remove", "context"]).optional(),
});

export type PlanVisualAnnotation = z.infer<typeof PlanVisualAnnotationSchema>;

/**
 * A visual attached to a plan (or spec) — rendered as a first-class,
 * commentable block alongside the explicit steps so the planning phase isn't a
 * wall of prose. One of:
 *   - "diagram"        — Mermaid source (flowchart / erDiagram / sequenceDiagram
 *                        / stateDiagram / classDiagram). The renderer is
 *                        fuzzy-safe: invalid Mermaid shows the source + an
 *                        error, never crashes.
 *   - "file_map"       — structured list of planned create/modify/delete ops.
 *   - "prototype"      — self-contained HTML/CSS rendered in a SANDBOXED iframe.
 *   - "annotated_code" — a real code snippet with line-anchored annotations,
 *                        rendered through the per-line-commentable code block so
 *                        the human can comment on the actual lines changing.
 *
 * Payload fields are per-kind and all optional so the structural validator
 * stays lenient; the renderer reads the field matching `kind`.
 */
export const PlanVisualSchema = z.object({
  /** Stable id — comments anchor to it. Keep it across revisions so a comment
   *  thread on a diagram survives the agent redrawing it. */
  id: z.string().describe("Stable id — comments anchor to it; KEEP IT ACROSS REVISIONS so a comment thread on a diagram survives the agent redrawing it"),
  kind: z.enum(["diagram", "file_map", "prototype", "annotated_code"]),
  title: z.string().optional(),
  caption: z.string().optional(),
  source: z.string().optional().describe("kind=diagram: Mermaid source"),
  files: z.array(PlanVisualFileSchema).optional().describe("kind=file_map: the planned file operations"),
  html: z.string().optional().describe("kind=prototype: a self-contained HTML document (rendered sandboxed)"),
  code: z.string().optional().describe("kind=annotated_code: the code snippet to render + annotate"),
  filePath: z.string().optional().describe("kind=annotated_code: source path (drives syntax highlighting + the per-line comment anchor)"),
  /** kind="annotated_code": override the language inferred from filePath. */
  language: z.string().optional(),
  /** kind="annotated_code": line number of the snippet's first line (default 1)
   *  so gutter numbers and annotations match the real file. */
  lineStart: z.number().optional(),
  /** kind="annotated_code": line-anchored explanations. */
  annotations: z.array(PlanVisualAnnotationSchema).optional(),
});

export type PlanVisual = z.infer<typeof PlanVisualSchema>;

export const PlanContentSchema = z.object({
  steps: z.array(PlanStepSchema),
  estimatedChanges: z.number(),
  /** Optional visuals (diagrams / file maps / prototypes) that frame the plan.
   *  Optional for back-compat. */
  visuals: z.array(PlanVisualSchema).optional(),
});

export type PlanContent = z.infer<typeof PlanContentSchema>;

// --- Spec (think together before building) ---

/**
 * A single requirement in a co-authored spec. Kept deliberately lightweight
 * (rationale + acceptance criteria) because the goal is "make the mental
 * model explicit so we can argue about it" — not ceremony.
 *
 * The pairing value: each requirement has a rationale the developer can
 * challenge ("why do we need this?") and acceptance criteria the agent can
 * verify against later ("did we achieve this?"). Both are teaching moments.
 */
export const SpecRequirementSchema = z.object({
  id: z.string().describe("Stable identifier within this spec, e.g. 'REQ-1'"),
  statement: z.string().describe("WHAT the requirement is, in one sentence"),
  rationale: z.string().describe("WHY — the reason this requirement exists"),
  acceptanceCriteria: z
    .array(z.string())
    .describe("Testable conditions that, if true, satisfy this requirement"),
  priority: z.enum(["must", "should", "could"]).optional(),
});

export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;

export const SpecTaskSchema = z.object({
  description: z.string(),
  /** Which requirement ids this task implements — the traceability link. */
  linkedRequirementIds: z.array(z.string()).optional(),
  estimate: z.enum(["xs", "s", "m", "l", "xl"]).optional(),
});

export type SpecTask = z.infer<typeof SpecTaskSchema>;

export const SpecContentSchema = z.object({
  objective: z.string().describe("One-sentence objective the spec is chasing"),
  context: z.string().optional().describe("Background / constraints / existing system notes"),
  requirements: z.array(SpecRequirementSchema).min(1).describe("The requirements — non-empty; each carries rationale + acceptance criteria"),
  /**
   * Optional design notes — NOT a full design doc, just the chosen shape at
   * a high level. The plan artifact is for implementation; design here lives
   * between "why" and "how" and helps the human sanity-check the approach.
   */
  design: z.string().optional(),
  tasks: z.array(SpecTaskSchema).optional(),
  openQuestions: z.array(z.string()).optional(),
  /** Visuals (diagrams / file maps / prototypes) that frame the spec — same
   *  block as plans. Optional for back-compat. */
  visuals: z.array(PlanVisualSchema).optional(),
});

export type SpecContent = z.infer<typeof SpecContentSchema>;

// --- Reasoning (the "show your work" artifact) ---

/** A named concept the agent is applying — the pairing-learning hook. */
export const ReasoningConceptSchema = z.object({
  name: z.string().describe("The concept name (e.g. 'dependency inversion', 'optimistic UI', 'debounce vs throttle')"),
  oneLineExplanation: z
    .string()
    .optional()
    .describe("One-sentence plain-English explanation for a developer who may not know the concept"),
});

export type ReasoningConcept = z.infer<typeof ReasoningConceptSchema>;

/** How this reasoning step connects to another artifact. */
export const ReasoningRelationSchema = z.object({
  artifactId: z.string(),
  kind: z.enum(["elaborates", "answers", "supersedes"]),
});

export type ReasoningRelation = z.infer<typeof ReasoningRelationSchema>;

export const ReasoningContentSchema = z.object({
  action: z.string().describe("What you're about to do, in plain English"),
  reasoning: z.string().describe("Why this approach"),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  /** Legacy: flat strings. New agents prefer alternativeDetails. */
  alternativesConsidered: z.array(z.string()).optional(),
  /** Rejected alternatives with structured reasons. */
  alternativeDetails: z
    .array(
      z.object({
        title: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  /**
   * The named concept the agent is applying. THIS IS THE PAIRING LEVER —
   * when the agent surfaces the concept by name (instead of just applying
   * it silently), the human learns the pattern, not just the fix.
   */
  concept: ReasoningConceptSchema.optional(),
  /** Files / lines that motivated this reasoning step. */
  evidence: z.array(EvidenceInputSchema).optional(),
  /** Back-link to another artifact this reasoning elaborates / answers. */
  relatesTo: ReasoningRelationSchema.optional(),
});

export type ReasoningContent = z.infer<typeof ReasoningContentSchema>;

/**
 * C6b — the ONE DecisionOption shape. It existed twice — DecisionOptionSchema
 * (decision.ts, the wire shape) and DecisionOptionContentSchema (artifact.ts,
 * the stored shape) — held in sync only by cross-referencing comments, and the
 * concept sub-schema had ALREADY drifted (artifact.ts's carried .describe()
 * metadata the wire copy lacked). Both files now alias this. If the wire and
 * stored shapes ever legitimately diverge, extend from this base rather than
 * forking it.
 */
export const DecisionOptionConceptSchema = z.object({
  // Min 1 so a present-but-empty `concept: { name: "" }` is rejected. An
  // empty string is worse than no concept at all — it pollutes the ledger
  // with a row that can never match anything, blocking nothing.
  name: z.string().min(1).describe("The underlying pattern (e.g. 'argon2id for password hashing', 'optimistic UI')"),
  oneLineExplanation: z
    .string()
    .optional()
    .describe("Plain-English so the human learns the pattern, not just the option"),
});

export const DecisionOptionBaseSchema = z.object({
  id: z.string().describe("Stable id — discussion threads anchor to it; KEEP IT ACROSS REVISIONS so a comment thread on an option survives a tune"),
  title: z.string(),
  description: z.string(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  effort: z.enum(["low", "medium", "high"]),
  risk: z.enum(["low", "medium", "high"]),
  recommendation: z.boolean(),
  concept: DecisionOptionConceptSchema.optional(),
  /** DV1 — optional per-option visuals (Mermaid diagram / file map /
   *  annotated code), reusing PlanVisualSchema so the whole render + comment
   *  stack applies. */
  visuals: z.array(PlanVisualSchema).optional(),
});

// --- Changeset (#171 — multi-file review as ONE artifact) ---
//
// The biggest gap vs. competitors: a change spanning files reviewed as a single
// unit, with per-file review state and comments that can anchor across files.
// Coexists with `code_change` (single-file); the agent picks changeset for
// changes spanning 2+ files. Unified-diff only.

/** One line of a unified-diff hunk. `kind` tags it context / addition /
 *  deletion; `oldLine`/`newLine` are the 1-based numbers shown in the gutter
 *  (a `del` line has no newLine, an `add` line has no oldLine, `ctx` has both).
 *  Both optional so a partial hunk still renders. */
export const ChangesetHunkLineSchema = z.object({
  kind: z.enum(["ctx", "add", "del"]),
  content: z.string(),
  oldLine: z.number().int().optional(),
  newLine: z.number().int().optional(),
});
export type ChangesetHunkLine = z.infer<typeof ChangesetHunkLineSchema>;

/** A unified-diff hunk: the `@@ -a,b +c,d @@` header plus its lines. */
export const ChangesetHunkSchema = z.object({
  header: z.string().optional().describe("Unified-diff hunk header, e.g. '@@ -24,9 +24,14 @@ export function requireSession(...)'"),
  lines: z.array(ChangesetHunkLineSchema),
});
export type ChangesetHunk = z.infer<typeof ChangesetHunkSchema>;

/** Per-file add/del tally driving the diffstat bars. Optional (all new fields
 *  optional per repo convention); the renderer derives it from the hunks when
 *  absent. */
export const ChangesetFileStatsSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type ChangesetFileStats = z.infer<typeof ChangesetFileStatsSchema>;

/** One file in a changeset: its path, how it changed, its unified-diff hunks,
 *  and an optional add/del stat. */
export const ChangesetFileSchema = z.object({
  path: z.string(),
  changeType: z.enum(["modified", "added", "deleted"]),
  hunks: z.array(ChangesetHunkSchema),
  stats: ChangesetFileStatsSchema.optional(),
});
export type ChangesetFile = z.infer<typeof ChangesetFileSchema>;

/** Per-file DISPOSITION, keyed by file path. HUMAN-driven (set via the
 *  changeset-review route, NOT by the agent), stored on the artifact content so
 *  it rides getArtifacts()/check_feedback and the WS full-artifact patch — the
 *  same in-content pattern update_plan_progress uses for step statuses. A
 *  Record (not Map) per the frontend-store convention. Optional; absent = no
 *  file dispositioned yet.
 *
 *  #175 — the disposition is now "reviewed" (looks right) or "needs_changes"
 *  (flag it with a reason — see reviewReasons). `"skipped"` is a LEGACY value:
 *  it is no longer PRODUCED (the "Skip for now" toggle is gone), but is kept in
 *  the enum so pre-#175 on-disk changesets still parse. On read the UI maps a
 *  legacy "skipped" to PENDING (no disposition) — a skipped file was never a
 *  real "yes", so it must be re-reviewed rather than silently unlock approval. */
export const ChangesetReviewStateSchema = z.record(
  z.string(),
  z.enum(["reviewed", "needs_changes", "skipped"]),
);
export type ChangesetReviewState = z.infer<typeof ChangesetReviewStateSchema>;

/** #175 — per-file "needs changes" REASONS, keyed by file path. Set alongside a
 *  `needs_changes` disposition; the send-back action composes these into the
 *  revision feedback the agent reads via check_feedback. Optional (all new
 *  fields optional); a Record per the frontend-store convention. */
export const ChangesetReviewReasonsSchema = z.record(z.string(), z.string());
export type ChangesetReviewReasons = z.infer<typeof ChangesetReviewReasonsSchema>;

export const ChangesetContentSchema = z.object({
  summary: z.string().optional(),
  files: z.array(ChangesetFileSchema),
  /** Risk annotations from the agent, per changeset (e.g. "touches auth",
   *  "migration included") — rendered as chips in the summary strip. */
  risks: z.array(z.string()).optional(),
  /** Human per-file disposition (set post-creation via the changeset-review route). */
  reviewState: ChangesetReviewStateSchema.optional(),
  /** #175 — per-file "needs changes" reasons (set post-creation via the
   *  changeset-review route), keyed by file path. */
  reviewReasons: ChangesetReviewReasonsSchema.optional(),
});
export type ChangesetContent = z.infer<typeof ChangesetContentSchema>;
