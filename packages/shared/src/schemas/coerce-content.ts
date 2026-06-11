import type { Artifact } from "./artifact.js";
import type { DecisionContent, CodeChangeContent } from "./artifact.js";
import type {
  ResearchContent,
  Finding,
  PlanContent,
  PlanStep,
  PlanBranch,
  SpecContent,
  SpecRequirement,
  SpecTask,
  ReasoningContent,
} from "./content-types.js";

/**
 * Coercion boundary for artifact `content`.
 *
 * Artifacts arrive from the store as a loosely-typed bag (`Record<string,
 * unknown>`): the agent might ship partial, legacy, or malformed content, and
 * the renderers had been casting it unchecked (`getTypedContent`) and then
 * guarding every field by hand — a crash-by-omission waiting to happen
 * (`steps.map` on a non-array, `objective.split` on undefined, …).
 *
 * These coercers are the single, tested place that turns raw content into a
 * fully-shaped, correctly-typed object: every required field is present, every
 * array IS an array, enums fall back to a neutral default. They NEVER throw and
 * NEVER drop data (valid fields pass through untouched). Renderers call the
 * matching coercer once and then trust the shape, so the per-field guards go
 * away. Defaults are chosen to preserve conditional rendering — `""` is falsy
 * like `undefined`, `[]` has length 0 — so well-formed content renders exactly
 * as before.
 *
 * This is deliberately NOT `parseArtifactContent` (strict Zod safeParse): strict
 * validation would REJECT a partial artifact and hide the very data the agent
 * sent. Coercion shows what it can and fills the gaps.
 */

// --- primitives ---------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d = false): boolean => (typeof v === "boolean" ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Array of plain strings only (drops non-string junk). */
const strArr = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
/** `undefined` unless it's a non-empty string. */
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** Required enum: the value if valid, else the supplied neutral default. */
function oneOf<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;
}
/** Optional enum: the value if valid, else `undefined` (no fabrication). */
function optOneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

const LMH = ["low", "medium", "high"] as const;

/** The shared "named concept" shape (decision option / code_change / reasoning). */
function coerceConcept(v: unknown): { name: string; oneLineExplanation?: string } | undefined {
  if (!isObj(v)) return undefined;
  const name = str(v.name);
  if (!name) return undefined; // matches the schema's `.min(1)` — empty concept is no concept
  const oneLineExplanation = optStr(v.oneLineExplanation);
  return oneLineExplanation ? { name, oneLineExplanation } : { name };
}

// --- research -----------------------------------------------------------------

function coerceFinding(v: unknown): Finding {
  const f = obj(v);
  const out: Finding = {
    category: str(f.category),
    detail: str(f.detail),
    significance: oneOf(f.significance, LMH, "low"),
  };
  if (typeof f.title === "string") out.title = f.title;
  // evidence is string | Evidence[]; keep a valid shape, else drop.
  if (typeof f.evidence === "string") out.evidence = f.evidence;
  else if (Array.isArray(f.evidence)) out.evidence = f.evidence.filter(isObj) as any;
  const severity = optOneOf(f.severity, ["info", "low", "medium", "high", "critical"] as const);
  if (severity) out.severity = severity;
  if (typeof f.impact === "string") out.impact = f.impact;
  if (typeof f.recommendation === "string") out.recommendation = f.recommendation;
  if (Array.isArray(f.relatedFindings)) out.relatedFindings = strArr(f.relatedFindings);
  const confidence = optOneOf(f.confidence, LMH);
  if (confidence) out.confidence = confidence;
  return out;
}

export function coerceResearchContent(raw: unknown): ResearchContent {
  const c = obj(raw);
  const out: ResearchContent = {
    summary: str(c.summary),
    findings: arr(c.findings).map(coerceFinding),
  };
  if (Array.isArray(c.openQuestions)) out.openQuestions = strArr(c.openQuestions);
  return out;
}

// --- plan ---------------------------------------------------------------------

/** files: string[] OR FileChange[] — keep whichever valid shape is present. */
function coerceFiles(v: unknown): (string | Record<string, unknown>)[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.every((x) => typeof x === "string") ? (v as string[]) : (v.filter(isObj) as any);
}

function coercePlanStep(v: unknown): PlanStep {
  const s = obj(v);
  const out: PlanStep = {
    description: str(s.description),
    reasoning: str(s.reasoning),
  };
  const files = coerceFiles(s.files);
  if (files) out.files = files as any;
  if (Array.isArray(s.motivatedBy)) out.motivatedBy = strArr(s.motivatedBy);
  if (isObj(s.preview)) {
    out.preview = {
      before: str(s.preview.before),
      after: str(s.preview.after),
      filePath: str(s.preview.filePath),
    };
  }
  // Conditional-branch fields (now first-class in PlanStepSchema).
  if (typeof s.condition === "string") out.condition = s.condition;
  if (Array.isArray(s.branches)) {
    out.branches = s.branches.filter(isObj).map((b) => {
      const branch: PlanBranch = {
        description: str(b.description),
        reasoning: str(b.reasoning),
      };
      const bf = coerceFiles(b.files);
      if (bf) branch.files = bf as PlanBranch["files"];
      return branch;
    });
  }
  return out;
}

export function coercePlanContent(raw: unknown): PlanContent {
  const c = obj(raw);
  return {
    steps: arr(c.steps).map(coercePlanStep),
    estimatedChanges: num(c.estimatedChanges),
  };
}

// --- spec ---------------------------------------------------------------------

function coerceRequirement(v: unknown): SpecRequirement {
  const r = obj(v);
  const out: SpecRequirement = {
    id: str(r.id),
    statement: str(r.statement),
    rationale: str(r.rationale),
    acceptanceCriteria: strArr(r.acceptanceCriteria),
  };
  const priority = optOneOf(r.priority, ["must", "should", "could"] as const);
  if (priority) out.priority = priority;
  return out;
}

function coerceTask(v: unknown): SpecTask {
  const t = obj(v);
  const out: SpecTask = { description: str(t.description) };
  if (Array.isArray(t.linkedRequirementIds)) out.linkedRequirementIds = strArr(t.linkedRequirementIds);
  const estimate = optOneOf(t.estimate, ["xs", "s", "m", "l", "xl"] as const);
  if (estimate) out.estimate = estimate;
  return out;
}

export function coerceSpecContent(raw: unknown): SpecContent {
  const c = obj(raw);
  const out: SpecContent = {
    objective: str(c.objective),
    requirements: arr(c.requirements).map(coerceRequirement),
  };
  if (typeof c.context === "string") out.context = c.context;
  if (typeof c.design === "string") out.design = c.design;
  if (Array.isArray(c.tasks)) out.tasks = c.tasks.map(coerceTask);
  if (Array.isArray(c.openQuestions)) out.openQuestions = strArr(c.openQuestions);
  return out;
}

// --- decision -----------------------------------------------------------------

function coerceOption(v: unknown): DecisionContent["options"][number] {
  const o = obj(v);
  const out: DecisionContent["options"][number] = {
    id: str(o.id),
    title: str(o.title),
    description: str(o.description),
    pros: strArr(o.pros),
    cons: strArr(o.cons),
    effort: oneOf(o.effort, LMH, "medium"),
    risk: oneOf(o.risk, LMH, "medium"),
    recommendation: bool(o.recommendation),
  };
  const concept = coerceConcept(o.concept);
  if (concept) out.concept = concept;
  return out;
}

export function coerceDecisionContent(raw: unknown): DecisionContent {
  const c = obj(raw);
  const out: DecisionContent = {
    context: str(c.context),
    options: arr(c.options).map(coerceOption),
    decisionId: str(c.decisionId),
  };
  const stakes = optOneOf(c.stakes, LMH);
  if (stakes) out.stakes = stakes;
  return out;
}

// --- code_change --------------------------------------------------------------

export function coerceCodeChangeContent(raw: unknown): CodeChangeContent {
  const c = obj(raw);
  const out: CodeChangeContent = {
    filePath: str(c.filePath),
    changeType: oneOf(c.changeType, ["create", "modify", "delete"] as const, "modify"),
    before: str(c.before),
    after: str(c.after),
    reasoning: str(c.reasoning),
  };
  const confidence = optOneOf(c.confidence, LMH);
  if (confidence) out.confidence = confidence;
  const concept = coerceConcept(c.concept);
  if (concept) out.concept = concept;
  return out;
}

// --- reasoning ----------------------------------------------------------------

export function coerceReasoningContent(raw: unknown): ReasoningContent {
  const c = obj(raw);
  const out: ReasoningContent = {
    action: str(c.action),
    reasoning: str(c.reasoning),
  };
  const confidence = optOneOf(c.confidence, LMH);
  if (confidence) out.confidence = confidence;
  if (Array.isArray(c.alternativesConsidered)) out.alternativesConsidered = strArr(c.alternativesConsidered);
  if (Array.isArray(c.alternativeDetails)) {
    out.alternativeDetails = c.alternativeDetails.filter(isObj).map((d) => ({
      title: str(d.title),
      reason: str(d.reason),
    }));
  }
  const concept = coerceConcept(c.concept);
  if (concept) out.concept = concept;
  if (Array.isArray(c.evidence)) out.evidence = c.evidence.filter(isObj) as any;
  if (isObj(c.relatesTo)) {
    const kind = optOneOf(c.relatesTo.kind, ["elaborates", "answers", "supersedes"] as const);
    if (typeof c.relatesTo.artifactId === "string" && kind) {
      out.relatesTo = { artifactId: c.relatesTo.artifactId, kind };
    }
  }
  return out;
}

// --- dispatcher ---------------------------------------------------------------

/** Coerce by artifact type. Returns null for types with no structured content
 *  (or an unknown type) so the caller can skip coercion. */
export function coerceArtifactContent(
  artifact: Pick<Artifact, "type" | "content">,
):
  | ResearchContent
  | PlanContent
  | SpecContent
  | DecisionContent
  | CodeChangeContent
  | ReasoningContent
  | null {
  switch (artifact.type) {
    case "research": return coerceResearchContent(artifact.content);
    case "plan": return coercePlanContent(artifact.content);
    case "spec": return coerceSpecContent(artifact.content);
    case "decision": return coerceDecisionContent(artifact.content);
    case "code_change": return coerceCodeChangeContent(artifact.content);
    case "reasoning": return coerceReasoningContent(artifact.content);
    default: return null;
  }
}
