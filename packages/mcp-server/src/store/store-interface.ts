import type { Artifact, ArtifactType, ArtifactStatus, Comment } from "@deeppairing/shared";

/** Allows both sync (FileStore) and async (DaemonClient) implementations */
type MaybePromise<T> = T | Promise<T>;

export interface DecisionRecord {
  decisionId: string;
  artifactId: string;
  context: string;
  options: any[];
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
}

export interface AddCommentParams {
  id: string;
  artifactId: string;
  content: string;
  author: "human" | "agent";
  target?: Record<string, unknown>;
  intent?: "comment" | "question" | "suggestion";
  parentCommentId?: string | null;
}

export interface RecordDecisionParams {
  decisionId: string;
  artifactId: string;
  context: string;
  options: any[];
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
  getFullState(): MaybePromise<{
    sessionId: string;
    artifacts: Artifact[];
    comments: Comment[];
    decisions: DecisionRecord[];
    planReviews: PlanReviewRecord[];
    autonomyLevel: string;
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
  updateArtifactStatus(artifactId: string, status: ArtifactStatus): MaybePromise<void>;
  getArtifacts(): MaybePromise<Artifact[]>;

  // Comments
  addComment(params: AddCommentParams): MaybePromise<Comment>;
  getCommentsForArtifact(artifactId: string): MaybePromise<Comment[]>;
  getUnacknowledgedComments(): MaybePromise<Comment[]>;
  acknowledgeComments(ids: string[]): MaybePromise<void>;
  /** Mark a question comment as answered by linking to the answer comment. */
  markCommentAnswered(commentId: string, answerCommentId: string): MaybePromise<void>;
  getComment(commentId: string): MaybePromise<Comment | undefined>;

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
  recordRejectedApproach(description: string, reason?: string, sourceArtifactId?: string, concept?: string): MaybePromise<void>;
  recordApprovedPattern(description: string): MaybePromise<void>;
  getSessionMemory(): MaybePromise<{ rejectedApproaches: RejectedApproach[]; approvedPatterns: string[] }>;
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

  // Autonomy
  setAutonomyLevel(level: "supervised" | "balanced" | "autonomous"): MaybePromise<void>;
  getAutonomyLevel(): MaybePromise<"supervised" | "balanced" | "autonomous">;

  // Feedback polling
  waitForFeedback(timeoutMs?: number): Promise<void>;
}
