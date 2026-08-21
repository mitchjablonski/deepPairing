import { z } from "zod";
import {
  DecisionOptionBaseSchema,
  DecisionOptionConceptSchema,
  ResearchContentSchema,
  PlanContentSchema,
  SpecContentSchema,
  ReasoningContentSchema,
  ChangesetContentSchema,
  DebriefContentSchema,
  ExplainerContentSchema,
} from "./content-types.js";

export const ArtifactTypeSchema = z.enum([
  "research",
  "plan",
  "decision",
  "code_change",
  "reasoning",
  "spec",
  // #171 — a change spanning 2+ files, reviewed as one unit (unified diffs +
  // per-file review state). Single-file changes stay `code_change`.
  "changeset",
  // #190 — the end-of-feature comprehension surface: ONE batched artifact that
  // summarizes what changed and why, the decisions the agent made alone, what
  // needs the human's eyes, and an ask-anything thread. The thesis's 80% case.
  "debrief",
  // #190 A2 — the read-only comprehension surface: a narrated, ordered
  // walk-through of how something WORKS (code archaeology / onboarding / spike
  // readout). Sections anchored to Evidence, WITHOUT findings' problem-framing.
  "explainer",
]);

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactStatusSchema = z.enum([
  "draft",
  "reviewing",
  "approved",
  "revised",
  "rejected",
  "superseded",
  "retracted",
  // "obsolete" — the agent moved on / the work was overcome by new information.
  // Distinct from rejected (human declined) and retracted (agent mistake): the
  // artifact was valid but the discussion overtook it. A terminal state, so it
  // drops out of "waiting for review".
  "obsolete",
]);

export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

/**
 * #187 — the CLOSED status on which the human may still LEAVE a late follow-up
 * comment (a new-input lane, NOT a review reopening). Only "approved" qualifies:
 * the review closed with a positive verdict, so a later comment is genuinely new
 * input on a standing artifact. The other closed statuses are traps and stay
 * comment-locked: "revised"/"superseded" are closed-with-successor (their old
 * threads already aggregate onto the successor version), and
 * "rejected"/"retracted"/"obsolete" were discarded. "draft" is NOT included here
 * — it's the OPEN review lane, gated separately. This is the ONE predicate the
 * UI (which lines to unlock for commenting) and the server (which comments get
 * `followUp:true`) share, so the two can never drift.
 */
export function isLateCommentableStatus(status: ArtifactStatus | string): boolean {
  return status === "approved";
}

/**
 * Q3 — the ONE closed-artifact status set. An artifact in one of these has
 * reached a terminal state the human can no longer act on, so anything hanging
 * off it (a response-less decision record, an unresolved plan review, a
 * "still open?" nag) is an ORPHAN, not a live obligation.
 *
 * This USED to be expressed three times, and the third copy disagreed:
 *   1. FileStore.isArtifactClosed (private) — the store's pending-decision /
 *      pending-plan-review filters,
 *   2. CLOSED_ARTIFACT_STATUSES in session-scan.ts (store-less mirror, kept in
 *      sync by a parity test in list-all-decisions.test.ts),
 *   3. check_feedback's `openArtifactIds` — which expressed OPEN-ness as
 *      `draft || reviewing` and therefore DROPPED a pending decision whose
 *      backing artifact had been SENT BACK (`revised`), while the store that
 *      produced the record still considered it live. One payload, two answers.
 * All three consumers of THAT question import this. Add a status here only when
 * the human genuinely can never act on it again.
 *
 * Q3 review — the claim is scoped ON PURPOSE. `draft || reviewing` also appears
 * in FileStore.resolveDecision, and that is NOT a fourth copy of this predicate:
 * it answers "may I advance this artifact to approved right now?", which
 * excludes `revised` deliberately (a sent-back artifact is open, but resolving a
 * decision must not overwrite the human's request-changes verdict). Same
 * literal, different question — do not unify it into this one.
 *
 * NOT closed, deliberately: "draft" (the open review lane), "revised" (sent
 * back — the successor work is still owed, so the record stays live) and
 * "reviewing". A note on "reviewing": as of Q3 NOTHING writes it. The status
 * schema declares it and five sites READ it, but zero code paths set it
 * (StatusUpdateBodySchema admits only approved/revised/rejected/obsolete, and
 * createArtifact always starts at "draft"). It stays in the OPEN set as
 * defensive handling of a schema-valid value — flagged, not built.
 */
const CLOSED_ARTIFACT_STATUSES: ReadonlySet<string> = new Set<string>([
  "superseded",
  "retracted",
  "rejected",
  "obsolete",
  "approved",
]);

/**
 * Q3 — see CLOSED_ARTIFACT_STATUSES. `undefined` (an artifact the caller's
 * session doesn't carry at all) is NOT closed: unknown ids stay live, mirroring
 * the store's own "unknown ids stay pending" stance.
 */
export function isClosedArtifactStatus(status: ArtifactStatus | string | undefined): boolean {
  return status !== undefined && CLOSED_ARTIFACT_STATUSES.has(status);
}

export const ArtifactStatusHistoryEntrySchema = z.object({
  status: ArtifactStatusSchema,
  at: z.string().datetime(),
});
export type ArtifactStatusHistoryEntry = z.infer<typeof ArtifactStatusHistoryEntrySchema>;

/**
 * V4/#158 — one secret-shape scanner match, persisted on the artifact so the
 * warning SURVIVES a reload (the old `secret_warning` WS broadcast was
 * fire-and-forget — and in daemon mode, the only production wiring, the
 * MCP-side broadcast is a no-op, so it never reached a browser at all).
 * Deliberately carries only the pattern PREFIX ("AKIA") and a human label
 * ("AWS access key id") — NEVER the matched value, so surfacing the warning
 * can't itself re-echo the secret into the DOM / export / logs.
 */
export const SecretWarningSchema = z.object({
  /** The pattern prefix that matched, e.g. "AKIA", "sk-", "PEM". */
  pattern: z.string(),
  /** Human-readable kind, e.g. "AWS access key id". */
  label: z.string(),
  /**
   * #160 — WHERE the pattern matched, so the banner can say
   * "in `steps[2].preview` (line 4)" instead of leaving the human to hunt.
   * `field` is the dotted/bracketed content path (omitted when the scanned
   * text was a single unlabeled string, e.g. a comment body); `line` is
   * 1-based within that field's text. Both derived from the match INDEX
   * only — the matched value is never captured. Optional for backward
   * compatibility: old artifacts without them still render.
   */
  field: z.string().optional(),
  line: z.number().int().positive().optional(),
});
export type SecretWarning = z.infer<typeof SecretWarningSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: ArtifactTypeSchema,
  version: z.number().int().positive(),
  parentId: z.string().nullable(),
  title: z.string(),
  status: ArtifactStatusSchema,
  /**
   * Timestamped trail of status transitions. Optional for backward
   * compatibility with older sessions — replay falls back to
   * createdAt/updatedAt when absent.
   */
  statusHistory: z.array(ArtifactStatusHistoryEntrySchema).optional(),
  /**
   * V-fix — set true when a HUMAN drove this artifact OUT of draft
   * (draft → approved / rejected / changes_requested) and check_feedback
   * has not yet reported that transition to the agent. Cleared once
   * reported (mirrors the comments/decisions `acknowledged` drain).
   * Agent-driven transitions (supersede/retract/obsolete) never set it —
   * the agent caused those, so they'd be noise. Optional for backward
   * compatibility (project rule: all new fields optional).
   */
  statusChangeUnreported: z.boolean().optional(),
  /**
   * V4/#158 — secret-scanner matches found in this artifact's content at
   * creation/revision time (see SecretWarningSchema). Set only when the scan
   * matched; omitted otherwise. Optional for backward compatibility (project
   * rule: all new fields optional).
   */
  secretWarnings: z.array(SecretWarningSchema).optional(),
  /**
   * #206 (I1) — the FEATURE tag. A short, STABLE slug naming the feature /
   * milestone this artifact belongs to (e.g. "milestone-7", "auth-rework"),
   * set from the `feature` param on the present_* tools and normalized
   * server-side through the SAME slug family the Features view's title-prefix
   * miner uses (see session-scan.normalizeFeatureId) — so an agent-tagged
   * "Milestone 7" and a "Milestone 7 — x"-TITLED artifact converge on the one
   * group key. Slug-shaped but deliberately NOT over-validated (trim + a length
   * cap only); grouping is tolerant of anything. Optional for backward
   * compatibility (project rule: all new fields optional) — old artifacts
   * without it simply fall back to the derived title/parent grouping, and its
   * ABSENCE keeps the stored JSON byte-identical to before.
   */
  featureId: z.string().trim().max(80).optional(),
  content: z.record(z.string(), z.unknown()),
  agentReasoning: z.string().nullable(),
  relatedArtifactIds: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

// --- Typed content schemas for artifact types not in content-types.ts ---
// U2 — these are now real Zod schemas (previously TypeScript-only
// interfaces), so the discriminated parseArtifactContent below can
// validate at the boundary instead of trusting the upstream `as T`.

/**
 * Y5 — named concept embedded directly on the option, hoisted from the
 * log_reasoning surface. PMF council: without a named concept at proposal
 * time, the ledger captures rejections as opaque strings ("considered:
 * 'use Redux'"), and the Y1 breadcrumb has nothing to expand into. Naming
 * the concept here makes EACH option a candidate ledger entry — when the
 * human rejects an option, we record the rejection against `concept.name`
 * (compact, comparable across projects) instead of the option's prose
 * description (project-specific, doesn't compound).
 *
 * Same shape as ReasoningConceptSchema in content-types.ts so the UI can
 * reuse the ConceptCallout component without translation. Optional —
 * existing call sites that don't supply concepts keep working.
 */
// C6b — stored shape aliases the shared base (content-types.ts); see the
// note there before diverging wire and stored shapes.
export const DecisionOptionContentSchema = DecisionOptionBaseSchema;

export const DecisionContentSchema = z.object({
  context: z.string(),
  /**
   * M1.1 — a SHORT question naming the fork ("Which storage format for tags?").
   * When present it is the card header + the artifact/session title + the
   * learnings-export heading + the whole-card-reject ledger key, while `context`
   * keeps the full background. OPTIONAL and backcompat: an absent title behaves
   * byte-identically to today (context is used everywhere it was). Capped/
   * trimmed at the tool-input boundary; lenient here for old artifacts.
   */
  title: z.string().optional(),
  options: z.array(DecisionOptionContentSchema),
  decisionId: z.string(),
  /** How consequential this decision is. Only "high" triggers prediction capture. */
  stakes: z.enum(["low", "medium", "high"]).optional(),
});

export type DecisionContent = z.infer<typeof DecisionContentSchema>;

export const CodeChangeContentSchema = z.object({
  filePath: z.string(),
  changeType: z.enum(["create", "modify", "delete"]),
  before: z.string(),
  after: z.string(),
  reasoning: z.string(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  /**
   * Y5 — named concept. Same shape as the option-level concept and the
   * reasoning-artifact concept, intentionally — UI reuses ConceptCallout
   * across all three. When this code change matches a rejected concept
   * across projects, the Y1 breadcrumb has something compact to compare
   * against; without it, preflight has only filePath + reasoning prose
   * to match against, which doesn't compound.
   */
  concept: DecisionOptionConceptSchema.optional(),
});

export type CodeChangeContent = z.infer<typeof CodeChangeContentSchema>;

/**
 * U2 — discriminated, validated artifact-content parser. Switches on
 * `artifact.type` and runs the matching Zod schema's `.safeParse`, returning
 * a typed payload OR a structured failure. This is the STRICT counterpart to
 * the renderer-facing `coerceArtifactContent` (which is lenient and never
 * fails): use this when a caller needs to know the content is well-formed
 * (validation, tooling), and the coercer when a renderer must show whatever
 * it can. On failure the parser returns `{ ok: false, error }` rather than
 * throwing.
 *
 * Falls back to ResearchContentSchema-style validation for `research`,
 * PlanContentSchema for `plan`, etc.
 */
type ParseResult<T> = { ok: true; data: T } | { ok: false; error: z.ZodError };

// D7 — SYNC. The old async form's lazy import cited a circular dep that is
// provably absent (this module already statically imports content-types
// values at the top). Async-only was the root cause of the server's
// content-cast plateau: every sync consumer cast instead of parsing.
export function parseArtifactContent(
  artifact: Artifact,
):
  | ParseResult<DecisionContent>
  | ParseResult<CodeChangeContent>
  | ParseResult<import("./content-types.js").ResearchContent>
  | ParseResult<import("./content-types.js").PlanContent>
  | ParseResult<import("./content-types.js").SpecContent>
  | ParseResult<import("./content-types.js").ReasoningContent>
  | ParseResult<import("./content-types.js").ChangesetContent>
  | ParseResult<import("./content-types.js").DebriefContent>
  | ParseResult<import("./content-types.js").ExplainerContent> {
  const schema = (() => {
    switch (artifact.type) {
      case "decision":     return DecisionContentSchema;
      case "code_change":  return CodeChangeContentSchema;
      case "research":     return ResearchContentSchema;
      case "plan":         return PlanContentSchema;
      case "spec":         return SpecContentSchema;
      case "reasoning":    return ReasoningContentSchema;
      case "changeset":    return ChangesetContentSchema;
      case "debrief":      return DebriefContentSchema;
      case "explainer":    return ExplainerContentSchema;
    }
  })();
  const result = schema.safeParse(artifact.content);
  if (result.success) return { ok: true, data: result.data as any };
  return { ok: false, error: result.error };
}
