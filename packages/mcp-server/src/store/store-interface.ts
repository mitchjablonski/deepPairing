import type { Artifact, ArtifactType, ArtifactStatus, Comment, CommentSuggestion, SuggestionState, SuggestionCounter, DecisionOption, PreflightTrace } from "@deeppairing/shared";

/** Allows both sync (FileStore) and async (DaemonClient) implementations */
type MaybePromise<T> = T | Promise<T>;

/**
 * U7 — closed enum of WHO / WHAT triggered a status transition. Carried in
 * the daemon log on every status mutation and (later) in
 * artifact.statusHistory entries so the timeline view can show "approved by
 * UI button" vs "approved by elicit accept" vs "auto-superseded by revise".
 *
 * `comment_side_effect` is a SENTINEL: nothing in the codebase should ever
 * pass it. Its presence in the log is a smoking gun for the U0.2 family of
 * bugs (commenting silently changes status). Catch it in code review.
 *
 * `unspecified` is the default for legacy callers that haven't been updated
 * yet — keeps the log audit-complete without a flag day.
 */
export type StatusTransitionReason =
  | "ui_approve_button"
  | "ui_revise_button"
  | "ui_reject_button"
  | "ui_decision_resolve"
  | "ui_bulk_accept"
  | "elicit_accept"
  | "agent_revise"
  | "agent_retract"
  | "agent_supersede"
  | "agent_obsolete"
  | "ui_dismiss_obsolete"
  | "demo_script"
  | "comment_side_effect"
  | "unspecified";

export interface DecisionRecord {
  decisionId: string;
  artifactId: string;
  context: string;
  /** C6c — typed via the unified DecisionOptionBaseSchema (was any[], the
   *  root of ~10 `as any` reads in check-feedback). */
  options: DecisionOption[];
  /** Agent-asserted consequentiality of the decision. */
  stakes?: "low" | "medium" | "high";
  response?: {
    optionId: string;
    reasoning?: string;
    confidence?: "low" | "medium" | "high";
    predictedOutcome?: string;
  };
  acknowledged?: boolean;
  createdAt: string;
  resolvedAt?: string;
}

export interface PlanReviewRecord {
  artifactId: string;
  verdict?: "approved" | "revised" | "rejected";
  feedback?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface CreateArtifactParams {
  id: string;
  type: ArtifactType;
  title: string;
  content: Record<string, unknown>;
  agentReasoning?: string;
  relatedArtifactIds?: string[];
  /** When set, this artifact versions a previous one (supersede flow). */
  parentId?: string | null;
  /** Override the default version of 1; used when superseding. */
  version?: number;
  // #162 — `secretWarnings` was REMOVED from this param shape: the store now
  // scans `content` authoritatively at create time (parity with addComment),
  // so callers no longer pre-compute or pass warnings — they read the result
  // off the returned artifact (`artifact.secretWarnings`) for the
  // `secret_warning` broadcast. A stale/older client sending the field over
  // the daemon's internal route (its body schema is .passthrough()) is
  // accepted on the wire but IGNORED — the store recomputes.
}

export interface AddCommentParams {
  id: string;
  artifactId: string;
  content: string;
  author: "human" | "agent";
  target?: Record<string, unknown>;
  intent?: "comment" | "question" | "suggestion";
  parentCommentId?: string | null;
  /** FN1 — code evidence attached to the comment (answer_question's `evidence`).
   *  Must be a first-class param so it survives the DaemonClient HTTP round-trip;
   *  pre-FN1 it was mutated onto the returned object and lost in daemon mode. */
  codeReferences?: Array<{ filePath: string; lineStart: number; lineEnd: number; snippet?: string }>;
  /** #172 — a first-class suggested edit posted with the comment (a plain
   *  Record so the store doesn't need to import the shared schema type). */
  suggestion?: CommentSuggestion;
}

/**
 * #172 — a partial mutation of a comment's `suggestion`. Fields are applied
 * over the existing suggestion; omitted fields are preserved. `resetAcknowledged`
 * re-queues the comment for check_feedback (used by the human take-counter /
 * insist actions so the agent's next poll picks up the new obligation).
 */
export interface SuggestionUpdate {
  state?: SuggestionState;
  appliedInVersion?: number;
  counter?: SuggestionCounter;
  resetAcknowledged?: boolean;
}

/**
 * #172 — the pure transition guard for the AGENT-driven surface (answer_question
 * + the internal daemon route). `updateCommentSuggestion` is a low-level setter;
 * these are the invariants a caller must enforce BEFORE calling it so a bad
 * transition can't (a) flip an insisted override back to countered — which the
 * "counter present ⇒ took-the-counter" ledger branch then mis-reads, destroying
 * the override record — or (b) silently re-stamp a shipped edit with a new
 * version. The human take/insist route never trips these (it only moves
 * countered → applied/insisted), so it doesn't call this.
 */
export function validateSuggestionTransition(
  current: CommentSuggestion,
  update: SuggestionUpdate,
): { ok: true } | { ok: false; code: string; message: string } {
  // A counter is only valid while the negotiation is still open.
  if (update.state === "countered") {
    if (current.state === "insisted") {
      return {
        ok: false,
        code: "suggestion_insisted_authoritative",
        message:
          "The human INSISTED on their exact version after your counter — it is authoritative. Apply it verbatim with suggestionState:\"applied\" + appliedInVersion; do not counter or re-argue.",
      };
    }
    if (current.appliedInVersion != null) {
      return {
        ok: false,
        code: "suggestion_already_applied",
        message: `This suggestion already shipped in v${current.appliedInVersion} — it can no longer be countered.`,
      };
    }
  }
  // The applied-version stamp is write-once (idempotent same-version is fine).
  if (
    update.appliedInVersion != null &&
    current.appliedInVersion != null &&
    current.appliedInVersion !== update.appliedInVersion
  ) {
    return {
      ok: false,
      code: "suggestion_already_applied",
      message: `This suggestion already shipped in v${current.appliedInVersion}; it can't be re-stamped as v${update.appliedInVersion}.`,
    };
  }
  return { ok: true };
}

export interface RecordDecisionParams {
  decisionId: string;
  artifactId: string;
  context: string;
  /** C6c — typed via the unified DecisionOptionBaseSchema (was any[], the
   *  root of ~10 `as any` reads in check-feedback). */
  options: DecisionOption[];
  stakes?: "low" | "medium" | "high";
}

export interface RejectedApproach {
  description: string;
  reason?: string;
  rejectedAt?: string;
  sourceArtifactId?: string;
  /**
   * The underlying concept this rejection covers — e.g. "cost-sensitivity on
   * low-traffic services". When set, pre-flight validation matches on concept
   * equality in addition to surface substring, so "Deploy to Fly.io" also
   * gets blocked after "Deploy to Railway" was rejected for the same reason.
   */
  concept?: string;
}

/**
 * Store interface — implemented by both FileStore (sync) and DaemonClient (async HTTP).
 * Methods use MaybePromise so FileStore can return values directly while DaemonClient
 * returns Promises. Callers should always `await` the result.
 */
export interface IStore {
  // Session
  getSessionId(): string;
  /**
   * AA7 — optional rename + cross-session reads. Both FileStore and
   * DaemonClient already implement these; lifting to IStore (as
   * optional, MaybePromise) lets callers stop casting `(store as any)`
   * and gives the type system a chance to flag a missed implementor
   * the next time a store is added.
   */
  renameSession?(title: string): MaybePromise<void>;
  /**
   * F1 — record a metric event the daemon's broadcast-tap can't see (because
   * the emitting code runs in the MCP-server process, whose broadcast is a
   * no-op in standalone). Today: real pre-flight blocks. Implemented by
   * DaemonClient (POSTs to the daemon's /metrics sink); FileStore omits it
   * (in a non-daemon deployment the broadcast tap already runs in-process).
   * Fire-and-forget — must never throw into the caller.
   */
  recordMetric?(event:
    | { kind: "preflight_block"; source: "session" | "team" }
    // Phase-1 (D) — near-misses that were ADMITTED (fuzzy signal for the
    // Phase-2 embeddings decision). Same daemon-side truth-point routing as
    // preflight_block: the MCP-server broadcast is a no-op in standalone.
    | { kind: "preflight_near_miss"; source: "session" | "team" }
  ): MaybePromise<void>;
  listPastSessions?(): MaybePromise<Array<{
    id: string;
    createdAt: string;
    lastActivity: string;
    summary: string;
    artifactCount: number;
    hasDecisions: boolean;
  }>>;
  loadPastSession?(sessionId: string): MaybePromise<any>;
  searchSessions?(query: string, limit?: number): MaybePromise<Array<{
    sessionId: string;
    sessionTitle: string;
    artifactId: string;
    artifactType: string;
    title: string;
    excerpt: string;
    score: number;
    matchedVia: string[];
  }>>;
  getFullState(): MaybePromise<{
    sessionId: string;
    artifacts: Artifact[];
    comments: Comment[];
    decisions: DecisionRecord[];
    planReviews: PlanReviewRecord[];
    autonomyLevel: string;
    detailDensity: string;
    sessionMemory: { rejectedApproaches: RejectedApproach[]; approvedPatterns: string[] };
    engagementMetrics: {
      avgReviewLatencyMs: number;
      commentDensity: number;
      approvalRate: number;
      reviewsByType: Record<string, { avgLatencyMs: number; count: number }>;
    };
  }>;
  forceFlush(): MaybePromise<void>;

  // Artifacts
  createArtifact(params: CreateArtifactParams): MaybePromise<Artifact>;
  renameArtifact(artifactId: string, title: string): MaybePromise<void>;
  /**
   * U7 — `reason` tag is OPTIONAL but recommended. It explains WHO/WHAT
   * caused the transition so the daemon log can attribute every status
   * change. If a transition would EVER carry the sentinel
   * `comment_side_effect` reason, that's a bug — comments must never
   * change artifact status. Older callers omitting `reason` get tagged
   * `unspecified` so the audit trail still has a value.
   */
  updateArtifactStatus(
    artifactId: string,
    status: ArtifactStatus,
    reason?: StatusTransitionReason,
  ): MaybePromise<void>;

  /**
   * D10 (H2) — joint execution tracking: patch step statuses on an existing
   * PLAN artifact in place (no supersede — execution progress is not a new
   * version). Returns the updated artifact for broadcasting, or null when
   * the artifact is missing or not a plan.
   */
  updatePlanProgress(
    artifactId: string,
    updates: Array<{ stepIndex: number; status: "pending" | "in_progress" | "done" | "skipped"; statusNote?: string }>,
  ): MaybePromise<Artifact | null>;
  /**
   * #171/#175 — set ONE file of a CHANGESET artifact's DISPOSITION in place
   * (human review PROGRESS, stored on the artifact content like plan progress —
   * NOT a decision record). `null` clears the file's state. #175 — the
   * disposition is "reviewed" (looks right) or "needs_changes" (flagged, with an
   * optional `reason` written to content.reviewReasons; legacy "skipped" is only
   * read, never written). Returns the updated artifact for broadcasting, or null
   * when the artifact is missing, not a changeset, or the path isn't part of it.
   * Optional so non-FileStore implementations (a read-only replay store) can skip it.
   */
  setChangesetFileReview?(
    artifactId: string,
    filePath: string,
    state: "reviewed" | "needs_changes" | "skipped" | null,
    reason?: string,
  ): MaybePromise<Artifact | null>;
  getArtifacts(): MaybePromise<Artifact[]>;

  /**
   * V-fix — artifacts whose HUMAN-driven draft→terminal transition
   * (approved / rejected / changes_requested) check_feedback has not yet
   * reported to the agent. Mirrors getUnacknowledgedComments /
   * getResolvedDecisions: read them, report once, then drain via
   * acknowledgeStatusChanges. Agent-driven transitions never appear here.
   */
  getUnacknowledgedStatusChanges(): MaybePromise<Artifact[]>;
  /** V-fix — drain the un-reported flag after check_feedback surfaced them. */
  acknowledgeStatusChanges(ids: string[]): MaybePromise<void>;

  // Comments
  addComment(params: AddCommentParams): MaybePromise<Comment>;
  getCommentsForArtifact(artifactId: string): MaybePromise<Comment[]>;
  getUnacknowledgedComments(): MaybePromise<Comment[]>;
  acknowledgeComments(ids: string[]): MaybePromise<void>;
  /** Mark a question comment as answered by linking to the answer comment. */
  markCommentAnswered(commentId: string, answerCommentId: string): MaybePromise<void>;
  /**
   * Mark a human's OWN unanswered question as resolved by the human. Sets
   * `humanResolvedAt`; no-op if the comment isn't found. Does NOT touch the
   * agent's `acknowledged` queue — this is a human-side "I'm done waiting"
   * signal so the "waiting on human" indicator stops counting it.
   */
  markCommentHumanResolved(commentId: string, resolvedAt?: string): MaybePromise<void>;
  getComment(commentId: string): MaybePromise<Comment | undefined>;
  /**
   * #172 — patch a comment's `suggestion` state machine. Applies `update` over
   * the existing suggestion, records the ledger side-effects of a newly-applied
   * suggestion (a genuine "why" → approved pattern; an insisted override →
   * recorded override), and returns the updated comment (or undefined if the
   * comment has no suggestion). Both FileStore and DaemonClient implement it.
   */
  updateCommentSuggestion(commentId: string, update: SuggestionUpdate): MaybePromise<Comment | undefined>;

  // Decisions
  recordDecisionRequest(params: RecordDecisionParams): MaybePromise<void>;
  /**
   * Resolve a decision. Optional prediction payload carries craft-development
   * signals (confidence + predicted outcome) captured on high-stakes decisions.
   */
  resolveDecision(
    decisionId: string,
    optionId: string,
    reasoning?: string,
    prediction?: { confidence?: "low" | "medium" | "high"; predictedOutcome?: string },
  ): MaybePromise<void>;
  getDecisionResponse(decisionId: string): MaybePromise<{ optionId: string; reasoning?: string } | null>;
  getPendingDecisions(): MaybePromise<DecisionRecord[]>;
  getDecision(decisionId: string): MaybePromise<DecisionRecord | undefined>;
  getResolvedDecisions(): MaybePromise<DecisionRecord[]>;
  acknowledgeDecisions(decisionIds: string[]): MaybePromise<void>;

  // Plan Reviews
  recordPlanReview(artifactId: string): MaybePromise<void>;
  resolvePlanReview(artifactId: string, verdict: "approved" | "revised" | "rejected", feedback?: string): MaybePromise<void>;
  getPlanReviewVerdict(artifactId: string): MaybePromise<{ verdict: string; feedback?: string } | null>;
  getPendingPlanReviews(): MaybePromise<PlanReviewRecord[]>;

  // Engagement & Memory
  recordArtifactReviewed(artifactId: string): MaybePromise<void>;
  getEngagementMetrics(): MaybePromise<{
    avgReviewLatencyMs: number;
    commentDensity: number;
    approvalRate: number;
    reviewsByType: Record<string, { avgLatencyMs: number; count: number }>;
    decisionsWithPredictions?: number;
    highStakesDecisions?: number;
  }>;
  /**
   * AA1 — typed-object signature replaces the prior 4-arg positional shape
   * (description, reason?, sourceArtifactId?, concept?). The positional
   * form hid bugs at every call site: server.ts:824 was passing
   * `option.description` as the concept arg, dropping the Y5-hoisted
   * `option.concept.name`. The global ledger keyed on that prose
   * description, so cross-project compounding was broken — every
   * project minted unique long keys instead of bucketing under
   * "pay-per-request hosting". Typed object surfaces every field
   * explicitly so the next refactor can't regress the same way.
   *
   * `concept` is the SHORT, ledger-comparable form (e.g. "argon2id for
   * password hashing"); `description` is the prose ("Use argon2id for
   * password hashing — bcrypt rounds=4 is brute-forceable"). Pre-AA1
   * the ledger fell back to description when concept was missing; that
   * fallback stays so legacy callers keep working.
   */
  recordRejectedApproach(params: {
    description: string;
    reason?: string;
    sourceArtifactId?: string;
    concept?: string;
  }): MaybePromise<void>;
  recordApprovedPattern(params: {
    description: string;
    concept?: string;
  }): MaybePromise<void>;
  /**
   * Scope-down a personal rejected-approach the pre-flight gate matched as a
   * false positive. Retires the matching local entry (so it stops blocking in
   * THIS project immediately) and records an `approved` counter-instance in the
   * global ledger (so the derived stance shifts off "avoid" and the same shape
   * stops tripping in future projects). Append-only ledger history is kept.
   * Returns how many local entries were retired.
   */
  overrideRejectedApproach(params: {
    description?: string;
    concept?: string;
  }): MaybePromise<{ retired: number }>;
  getSessionMemory(): MaybePromise<{ rejectedApproaches: RejectedApproach[]; approvedPatterns: string[] }>;
  /**
   * III8 — per-project opt-in to PUBLISH this project's rejections /
   * approvals into the cross-project ~/.deeppairing/philosophy ledger.
   * Default is off (opt-in). Reads from the global ledger are always
   * unfiltered — the gate is only on the WRITE path. Optional on the
   * interface so impls that don't honor the gate (test fakes) still
   * compile; real impls (FileStore + DaemonClient) must implement it.
   */
  setGlobalLedgerPublish?(enabled: boolean): MaybePromise<void>;
  getGlobalLedgerPublish?(): MaybePromise<boolean>;
  /**
   * BB4 — cross-project ledger digest, the moat surface AA5 added for the
   * UI. Optional because not every IStore impl can produce one (the
   * shape requires walking projectRoot's sessions dir). Both FileStore
   * (direct) and DaemonClient (via /api/ledger/digest) implement it.
   * Returns the same shape as /api/ledger/digest including
   * `globalLedger` (cross-project totals) so the agent-facing recall
   * tool can render the moat status without making a second call.
   */
  getLedgerDigest?(): MaybePromise<{
    shapedThisProject: number;
    nearMissesThisProject: number;
    blockedThisProject: number;
    sessionsTouched: number;
    topCitedStances: Array<{
      concept: string;
      source: "session" | "team";
      citationCount: number;
      /**
       * EE3/FF4 — cross-project citation count (sum of non-manual
       * instances for this concept across the global ledger). Lets
       * the agent narrate "cited N× here, M× cross-project" so the
       * moat-compounds-across-projects pitch is visible at the wire.
       * Optional for back-compat with pre-EE3 FileStore stubs.
       */
      globalCitationCount?: number;
      sampleArtifactId?: string;
      sampleSessionId?: string;
    }>;
    globalLedger: { concepts: number; projects: number; multiProjectConcepts: number };
  }>;
  /**
   * Filesystem-sensed guardrails for this project (migrations, workflows,
   * infra paths). Used by the MCP server in firstCallHint so the agent
   * knows to escalate for changes in these paths.
   */
  getProjectGuardrails?(): MaybePromise<Array<{ category: string; paths: string[]; rationale: string }>>;
  /**
   * Team-agreed conventions loaded from `.deeppairing/team.json`. Empty
   * array when absent. Surfaced separately from personal philosophy and
   * structural guardrails — never merged. See team-preferences.ts for the
   * three-layer rationale.
   */
  getTeamPreferences?(): MaybePromise<Array<{
    id: string;
    kind: "require" | "prefer" | "avoid";
    concept: string;
    rationale: string;
    scope?: { paths?: string[] };
    addedBy?: string;
    addedAt?: string;
  }>>;

  /**
   * Z1 — sidecar preflight trace persistence (Y1' substrate). Optional on
   * the interface so DaemonClient + FileStore can both implement without
   * forcing every consumer to know the difference. Pre-Z1 these existed
   * only on FileStore and the call sites cast `(store as any)`, which
   * meant DaemonClient (the production daemon-mode store) silently
   * no-op'd trace persistence — every standalone-wrapper user got an
   * invisible breadcrumb.
   */
  recordPreflightTrace?(artifactId: string, trace: PreflightTrace): MaybePromise<void>;
  getPreflightTrace?(artifactId: string): MaybePromise<PreflightTrace | null>;

  // Autonomy
  setAutonomyLevel(level: "supervised" | "balanced" | "autonomous"): MaybePromise<void>;
  getAutonomyLevel(): MaybePromise<"supervised" | "balanced" | "autonomous">;

  // #139 — detail density (verbosity). Orthogonal to autonomy: this governs
  // how much PROSE rides inside each artifact, not how many artifacts post or
  // whether the agent waits for approval. Optional in the store's persisted
  // shape; absent means "rich" (today's behavior).
  setDetailDensity(density: "rich" | "terse"): MaybePromise<void>;
  getDetailDensity(): MaybePromise<"rich" | "terse">;

  // Feedback polling
  waitForFeedback(timeoutMs?: number): Promise<void>;
}
