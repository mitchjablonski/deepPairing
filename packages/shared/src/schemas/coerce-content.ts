import type { Artifact } from "./artifact.js";
import type { DecisionContent, CodeChangeContent } from "./artifact.js";
import type {
  ResearchContent,
  Finding,
  PlanContent,
  PlanStep,
  PlanBranch,
  PlanVisual,
  PlanVisualFile,
  PlanVisualAnnotation,
  SpecContent,
  SpecRequirement,
  SpecTask,
  ReasoningContent,
  ChangesetContent,
  ChangesetFile,
  ChangesetHunk,
  ChangesetHunkLine,
  ChangesetReviewState,
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
  // evidence is string | (string | Evidence)[]; MIXED arrays are schema-legal
  // (EvidenceInputSchema is a union). D7 review — the old object-only filter
  // silently dropped legacy string elements, violating this file's own
  // never-drop-data contract (and making the exporter's string branch dead).
  if (typeof f.evidence === "string") out.evidence = f.evidence;
  else if (Array.isArray(f.evidence)) {
    out.evidence = f.evidence.filter((x: unknown) => typeof x === "string" || isObj(x)) as any;
  }
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
  // D10 (H2) — execution tracking. Without this passthrough the coercer
  // (which builds `out` field-by-field) silently STRIPPED the statuses the
  // agent just wrote, and the live checklist never rendered from coerced
  // content.
  if (s.status === "pending" || s.status === "in_progress" || s.status === "done" || s.status === "skipped") {
    out.status = s.status;
  }
  if (typeof s.statusNote === "string") out.statusNote = s.statusNote;
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
  const out: PlanContent = {
    steps: arr(c.steps).map(coercePlanStep),
    estimatedChanges: num(c.estimatedChanges),
  };
  if (Array.isArray(c.visuals)) {
    out.visuals = c.visuals.map((v, i) => coerceVisual(v, `visual_${i}`));
  }
  return out;
}

/** Small non-crypto stable string hash (djb2) → base36. */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * F4 — a visual with no `id` used to get a positional fallback (`visual_0`),
 * so inserting/reordering a visual between revisions shifted the ids and the
 * revision diff matched unrelated visuals (everything after the insert read as
 * "changed"). Derive a CONTENT-stable id instead, so the same visual keeps the
 * same id across versions regardless of position. Falls back to the positional
 * id only for an empty visual (nothing to key on).
 */
function visualFallbackId(o: Record<string, unknown>, indexFallback: string): string {
  const kind = typeof o.kind === "string" ? o.kind : "visual";
  const parts = [o.title, o.source, o.html, o.code, o.filePath, o.files, o.annotations];
  const hasContent = parts.some(
    (p) => p != null && (typeof p !== "string" || p.length > 0) && (!Array.isArray(p) || p.length > 0),
  );
  return hasContent ? `${kind}_${hashStr(JSON.stringify(parts))}` : indexFallback;
}

/** Coerce a plan visual to a fully-shaped block (id always present so comments
 *  can anchor; kind a valid enum; payload fields kept when the right type). */
function coerceVisual(v: unknown, fallbackId: string): PlanVisual {
  const o = obj(v);
  const out: PlanVisual = {
    id: str(o.id) || visualFallbackId(o, fallbackId),
    kind: oneOf(o.kind, ["diagram", "file_map", "prototype", "annotated_code"] as const, "diagram"),
  };
  if (typeof o.title === "string") out.title = o.title;
  if (typeof o.caption === "string") out.caption = o.caption;
  if (typeof o.source === "string") out.source = o.source;
  if (typeof o.html === "string") out.html = o.html;
  if (Array.isArray(o.files)) {
    out.files = o.files.filter(isObj).map((f): PlanVisualFile => {
      const file: PlanVisualFile = { path: str(f.path) };
      const change = optOneOf(f.change, ["create", "modify", "delete"] as const);
      if (change) file.change = change;
      if (typeof f.note === "string") file.note = f.note;
      return file;
    });
  }
  // annotated_code payload
  if (typeof o.code === "string") out.code = o.code;
  if (typeof o.filePath === "string") out.filePath = o.filePath;
  if (typeof o.language === "string") out.language = o.language;
  if (typeof o.lineStart === "number" && Number.isFinite(o.lineStart)) out.lineStart = o.lineStart;
  if (Array.isArray(o.annotations)) {
    out.annotations = o.annotations
      .filter(isObj)
      .filter((a) => typeof a.line === "number" && Number.isFinite(a.line) && typeof a.note === "string")
      .map((a): PlanVisualAnnotation => {
        const ann: PlanVisualAnnotation = { line: a.line as number, note: a.note as string };
        const kind = optOneOf(a.kind, ["add", "change", "remove", "context"] as const);
        if (kind) ann.kind = kind;
        return ann;
      });
  }
  return out;
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
  if (Array.isArray(c.visuals)) out.visuals = c.visuals.map((v, i) => coerceVisual(v, `visual_${i}`));
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
  // DV1 — per-option visuals. The option-scoped fallback id (`${id}_visual_${i}`)
  // only kicks in for a CONTENT-LESS visual; coerceVisual content-hashes when
  // there's content, which already distinguishes distinct diagrams. In the
  // present_options flow the write path stamps this same option-scoped id before
  // persistence, so a re-coerce keeps it (no drift); the scoping just guarantees
  // two options that both omit ids + content can't collide on `visual_0`.
  if (Array.isArray(o.visuals)) {
    out.visuals = o.visuals.map((vis, i) => coerceVisual(vis, `${out.id}_visual_${i}`));
  }
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

// --- changeset (#171) ---------------------------------------------------------

function coerceHunkLine(v: unknown): ChangesetHunkLine {
  const l = obj(v);
  const out: ChangesetHunkLine = {
    kind: oneOf(l.kind, ["ctx", "add", "del"] as const, "ctx"),
    content: str(l.content),
  };
  if (typeof l.oldLine === "number" && Number.isFinite(l.oldLine)) out.oldLine = l.oldLine;
  if (typeof l.newLine === "number" && Number.isFinite(l.newLine)) out.newLine = l.newLine;
  return out;
}

function coerceHunk(v: unknown): ChangesetHunk {
  const h = obj(v);
  const out: ChangesetHunk = { lines: arr(h.lines).map(coerceHunkLine) };
  if (typeof h.header === "string") out.header = h.header;
  return out;
}

function coerceChangesetFile(v: unknown): ChangesetFile {
  const f = obj(v);
  const out: ChangesetFile = {
    path: str(f.path),
    changeType: oneOf(f.changeType, ["modified", "added", "deleted"] as const, "modified"),
    hunks: arr(f.hunks).map(coerceHunk),
  };
  if (isObj(f.stats)) {
    out.stats = {
      additions: num((f.stats as Record<string, unknown>).additions),
      deletions: num((f.stats as Record<string, unknown>).deletions),
    };
  }
  return out;
}

/** Keep only "reviewed"/"skipped" values (drop junk) so the renderer trusts
 *  the map. */
function coerceReviewState(v: unknown): ChangesetReviewState | undefined {
  if (!isObj(v)) return undefined;
  const out: ChangesetReviewState = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === "reviewed" || val === "skipped") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function coerceChangesetContent(raw: unknown): ChangesetContent {
  const c = obj(raw);
  const out: ChangesetContent = {
    files: arr(c.files).map(coerceChangesetFile),
  };
  if (typeof c.summary === "string") out.summary = c.summary;
  if (Array.isArray(c.risks)) out.risks = strArr(c.risks);
  const reviewState = coerceReviewState(c.reviewState);
  if (reviewState) out.reviewState = reviewState;
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
  | ChangesetContent
  | null {
  switch (artifact.type) {
    case "research": return coerceResearchContent(artifact.content);
    case "plan": return coercePlanContent(artifact.content);
    case "spec": return coerceSpecContent(artifact.content);
    case "decision": return coerceDecisionContent(artifact.content);
    case "code_change": return coerceCodeChangeContent(artifact.content);
    case "reasoning": return coerceReasoningContent(artifact.content);
    case "changeset": return coerceChangesetContent(artifact.content);
    default: return null;
  }
}
