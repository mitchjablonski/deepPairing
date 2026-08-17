import { z } from "zod";
import { SecretWarningSchema } from "./artifact.js";

/**
 * G1 (#198b) — the REQUEST COMPOSER's persisted unit. The human can finally
 * INITIATE: compose a free-text request to the agent, tagged with one of three
 * intent presets that tell the agent which artifact type fulfils it:
 *
 *   - "explain" — "Explain how ___ works"        → present_explainer
 *   - "plan"    — "Plan ___ before building"     → present_plan / present_spec
 *   - "status"  — "Status?"                       → present_debrief-style summary
 *
 * A request is session-scoped and survives daemon restarts (it lives in the
 * per-project session store, like comments). It is NOT a new artifact type —
 * it's a lightweight signal the agent reads via check_feedback (a priority line,
 * ranked AFTER unanswered questions and AFTER freshly-rejected artifacts) or,
 * when no agent is live, via the composer's one-click resume-prompt (mirroring
 * ResumeQuestionsBanner). `servedByArtifactId` is set when the agent links a
 * fulfilling artifact — the UI reads it to show a served/unserved state.
 */
export const RequestIntentSchema = z.enum(["explain", "plan", "status"]);
export type RequestIntent = z.infer<typeof RequestIntentSchema>;

/**
 * P2 (round-11 MED 3) — WHERE the request came from. Pre-P2 a one-click
 * "Explain this file" request was byte-indistinguishable from a hand-typed
 * composer request: the scope lived only in the emitted PROSE, so copy drift
 * silently degraded a hunk-scoped ask into a whole-codebase tour and the agent
 * had nothing structured to auto-link `relatedArtifactIds` from. Optional for
 * backward compatibility — an old stored request without it loads unchanged,
 * and absent means "composer" (the only pre-P2 producer).
 */
export const RequestSourceSchema = z.enum(["composer", "walk_me_through"]);
export type RequestSource = z.infer<typeof RequestSourceSchema>;

/**
 * P2 (round-11 MED 3) — the request's scope as DATA, not prose. Every field is
 * optional (a scope may name only an artifact, only a file, or a file + line
 * range) and the whole object is optional on a request. The human-readable
 * `text` stays the PRIMARY instruction — this is additive structure the agent
 * can trust when the prose and the data disagree.
 */
export const RequestScopeSchema = z.object({
  /** The artifact the request was fired from (or the artifact it points at). */
  artifactId: z.string().optional(),
  /** Repo-relative path the ask is scoped to. */
  filePath: z.string().optional(),
  /** 1-based inclusive line range (hunk grain). Read WITH `side`. */
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  /**
   * P2 review F1 — WHICH SIDE of the diff `lineStart`/`lineEnd` are numbered on.
   * "new" = post-change lines, which are what the working tree holds (the safe
   * default; absent means "new"). "old" = PRE-change lines, emitted only for a
   * pure-deletion hunk: those lines NO LONGER EXIST in the file, so an agent
   * that opens the path at that range reads unrelated code and confidently
   * explains the wrong thing. Never leave the side implicit for an old-side
   * range.
   */
  side: z.enum(["new", "old"]).optional(),
  /**
   * P2 review F2 — a MIXED hunk's deletions. `lineStart`/`lineEnd` cover the
   * new-side lines, which by construction exclude every removed line, so a hunk
   * that is mostly deletions would deliver a range that omits exactly what the
   * human clicked on. These carry the removed lines' PRE-change envelope so the
   * agent knows to read them from the diff.
   */
  oldStart: z.number().int().positive().optional(),
  oldEnd: z.number().int().positive().optional(),
  /** How many lines the hunk removes (drives the "+ N lines removed" clause). */
  removedLineCount: z.number().int().positive().optional(),
  /** P2 review F1 — the file itself is DELETED in this changeset: the path is
   *  gone from the working tree and only the diff holds it. */
  fileRemoved: z.boolean().optional(),
  /** A within-artifact anchor (e.g. "debrief:needs-your-eyes:2"). */
  itemRef: z.string().optional(),
  /**
   * P2 review F6 — where the ask was FIRED FROM, when that differs from what it
   * points AT. A debrief's needs-your-eyes item scopes to the artifact it links
   * (`artifactId`), but `itemRef` anchors into the DEBRIEF — without this the
   * anchor names a position in an artifact the scope never identifies.
   */
  sourceArtifactId: z.string().optional(),
});
export type RequestScope = z.infer<typeof RequestScopeSchema>;

export const RequestSchema = z.object({
  id: z.string(),
  /** The human's free text (the fill-in for the preset, e.g. "the auth middleware"). */
  text: z.string().min(1),
  /** Which preset the human chose — drives the artifact type the agent serves with. */
  intent: RequestIntentSchema,
  createdAt: z.string().datetime(),
  /**
   * Set when the agent links a fulfilling artifact (via the present_* tools'
   * optional `servedRequestId` param). Absent = unserved (the agent still owes
   * a response). Optional for backward compatibility (project rule: all new
   * fields optional) — an old stored request without it loads unchanged.
   */
  servedByArtifactId: z.string().optional(),
  /**
   * #204 (code lens F1) — secret-scanner matches found in the request's `text`
   * at create time. A request is HUMAN-authored free text (the same risk as a
   * comment: a key pasted into the composer then flows into agent context via
   * check_feedback and lands on disk), so `FileStore.addRequest` scans and
   * persists the labels-only result here — pattern prefix + label (+ line),
   * NEVER the matched value. This closes the last human-text ingress that
   * bypassed the store-authoritative scan already covering comments (#160),
   * artifact content (#158), and render failures (#176). Optional for backward
   * compatibility (project rule: all new fields optional) — an old stored
   * request without it loads unchanged.
   */
  secretWarnings: z.array(SecretWarningSchema).optional(),
  /**
   * P2 — which surface produced this request ("composer" = the free-text
   * composer, "walk_me_through" = a one-click Explain-this affordance). Optional
   * (back-compat): absent = composer.
   */
  source: RequestSourceSchema.optional(),
  /**
   * P2 — the request's scope as structured data (artifact / file / line range /
   * item anchor). Optional (back-compat): absent = unscoped, exactly like every
   * pre-P2 request.
   */
  scope: RequestScopeSchema.optional(),
});
export type Request = z.infer<typeof RequestSchema>;

/** Human-readable phrasing of a request's intent — shared so the composer, the
 *  check_feedback delivery line, and the first-call obligations inventory all
 *  describe a request the same way (no drift). */
export function describeRequestIntent(intent: RequestIntent): string {
  switch (intent) {
    case "explain":
      return "explain how it works (present_explainer)";
    case "plan":
      return "plan it before building (present_plan / present_spec)";
    case "status":
      return "a status summary (present_debrief-style)";
  }
}

/**
 * P2 — render a request's structured scope as one compact clause, shared so the
 * check_feedback delivery line and any future surface describe it identically.
 * Returns "" when the scope names nothing (so an unscoped/legacy request's
 * delivered text stays byte-identical to pre-P2).
 */
export function describeRequestScope(scope: RequestScope | undefined): string {
  if (!scope) return "";
  const parts: string[] = [];
  if (scope.filePath) {
    const range =
      scope.lineStart != null
        ? `:${scope.lineStart}${scope.lineEnd != null && scope.lineEnd !== scope.lineStart ? `-${scope.lineEnd}` : ""}`
        : "";
    parts.push(`${scope.filePath}${range}`);
    // P2 review F1 — an OLD-side range must never travel bare: the agent's
    // natural move is to open the path at those numbers in the WORKING TREE,
    // which after the change holds different code. Say so in the same breath.
    if (scope.side === "old" && scope.lineStart != null) {
      parts.push(
        "PRE-change lines — this hunk is a pure deletion, so those lines no longer exist in the working tree; read them from the changeset diff, not the file",
      );
    }
    // P2 review F2 — a mixed hunk's removed lines fall OUTSIDE the new-side
    // range by construction; name them explicitly or they go unexplained.
    if (scope.side !== "old" && scope.oldStart != null) {
      const removed =
        scope.removedLineCount != null
          ? `${scope.removedLineCount} line${scope.removedLineCount === 1 ? "" : "s"}`
          : "lines";
      const oldRange = `${scope.oldStart}${scope.oldEnd != null && scope.oldEnd !== scope.oldStart ? `-${scope.oldEnd}` : ""}`;
      parts.push(`plus ${removed} removed (pre-change ${oldRange}) — read those from the diff`);
    }
    if (scope.fileRemoved) {
      parts.push("this file was DELETED in this changeset — it is gone from the working tree; read it from the diff");
    }
  }
  if (scope.artifactId) {
    parts.push(`artifact ${scope.artifactId}${scope.sourceArtifactId ? ` (flagged in ${scope.sourceArtifactId})` : ""}`);
  } else if (scope.sourceArtifactId) {
    parts.push(`artifact ${scope.sourceArtifactId}`);
  }
  if (scope.itemRef) parts.push(scope.itemRef);
  return parts.join(" · ");
}
