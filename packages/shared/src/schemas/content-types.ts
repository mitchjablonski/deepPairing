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
  significance: z.enum(["low", "medium", "high"]),
  /**
   * Risk level for prioritization ("if we don't address this, how bad?").
   * Distinct from significance. Helps the developer know what to learn from
   * first. Optional so older sessions remain valid.
   */
  severity: FindingSeveritySchema.optional(),
  /**
   * How confident the agent is in this finding. The `present_findings` tool
   * accepts it and the UI renders a confidence badge, so it must be modelled
   * here — otherwise the non-strict validation boundary silently strips it
   * before the artifact is persisted. Optional for back-compat.
   */
  confidence: z.enum(["low", "medium", "high"]).optional(),
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
  id: z.string(),
  kind: z.enum(["diagram", "file_map", "prototype", "annotated_code"]),
  title: z.string().optional(),
  caption: z.string().optional(),
  /** kind="diagram": Mermaid source. */
  source: z.string().optional(),
  /** kind="file_map": the planned file operations. */
  files: z.array(PlanVisualFileSchema).optional(),
  /** kind="prototype": a self-contained HTML document (rendered sandboxed). */
  html: z.string().optional(),
  /** kind="annotated_code": the code snippet to render + annotate. */
  code: z.string().optional(),
  /** kind="annotated_code": source path (drives syntax highlighting + the
   *  per-line comment anchor). */
  filePath: z.string().optional(),
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
  requirements: z.array(SpecRequirementSchema),
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
