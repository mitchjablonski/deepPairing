/**
 * DaemonClient — HTTP client that implements IStore by proxying
 * all operations to the shared deepPairing daemon.
 */
import type { Artifact, ArtifactStatus, Comment } from "@deeppairing/shared";
import type {
  IStore,
  DecisionRecord,
  PlanReviewRecord,
  CreateArtifactParams,
  AddCommentParams,
  RecordDecisionParams,
  RejectedApproach,
} from "./store/store-interface.js";

export class DaemonClient implements IStore {
  private baseUrl: string;
  private sessionId: string;

  constructor(port: number, sessionId: string) {
    this.baseUrl = `http://localhost:${port}/api/internal/sessions/${sessionId}`;
    this.sessionId = sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private async post<T = any>(path: string, body?: any): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  private async get<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return res.json();
  }

  // --- Session lifecycle ---

  async register(meta?: { title?: string; project?: string }): Promise<void> {
    await this.post("/register", meta ?? {});
  }

  async renameSession(title: string): Promise<void> {
    await this.post("/rename", { title });
  }

  async unregister(): Promise<void> {
    await this.post("/unregister");
  }

  // --- Artifacts ---

  async createArtifact(params: CreateArtifactParams): Promise<Artifact> {
    const data = await this.post<{ artifact: Artifact }>("/artifacts", params);
    return data.artifact;
  }

  async renameArtifact(artifactId: string, title: string): Promise<void> {
    await this.post(`/artifacts/${artifactId}/rename`, { title });
  }

  async updateArtifactStatus(artifactId: string, status: ArtifactStatus): Promise<void> {
    await this.post(`/artifacts/${artifactId}/status`, { status });
  }

  async getArtifacts(): Promise<Artifact[]> {
    const data = await this.get<{ artifacts: Artifact[] }>("/artifacts");
    return data.artifacts;
  }

  // --- Comments ---

  async addComment(params: AddCommentParams): Promise<Comment> {
    const data = await this.post<{ comment: Comment }>("/comments", params);
    return data.comment;
  }

  async getCommentsForArtifact(artifactId: string): Promise<Comment[]> {
    const data = await this.get<{ comments: Comment[] }>(`/artifacts/${artifactId}/comments`);
    return data.comments;
  }

  async getUnacknowledgedComments(): Promise<Comment[]> {
    const data = await this.get<{ comments: Comment[] }>("/comments/unacknowledged");
    return data.comments;
  }

  async acknowledgeComments(ids: string[]): Promise<void> {
    await this.post("/comments/acknowledge", { ids });
  }

  async getComment(commentId: string): Promise<Comment | undefined> {
    const data = await this.get<{ comment: Comment | null }>(`/comments/${commentId}`);
    return data.comment ?? undefined;
  }

  async markCommentAnswered(commentId: string, answerCommentId: string): Promise<void> {
    await this.post(`/comments/${commentId}/answered`, { answerCommentId });
  }

  // --- Decisions ---

  async recordDecisionRequest(params: RecordDecisionParams): Promise<void> {
    await this.post("/decisions", params);
  }

  async resolveDecision(decisionId: string, optionId: string, reasoning?: string): Promise<void> {
    await this.post(`/decisions/${decisionId}/resolve`, { optionId, reasoning });
  }

  async getDecisionResponse(decisionId: string): Promise<{ optionId: string; reasoning?: string } | null> {
    const data = await this.get<{ response: any }>(`/decisions/${decisionId}/response`);
    return data.response ?? null;
  }

  async getPendingDecisions(): Promise<DecisionRecord[]> {
    const data = await this.get<{ decisions: DecisionRecord[] }>("/decisions/pending");
    return data.decisions;
  }

  async getDecision(decisionId: string): Promise<DecisionRecord | undefined> {
    const data = await this.get<{ decision: DecisionRecord | undefined }>(`/decisions/${decisionId}`);
    return data.decision;
  }

  async getResolvedDecisions(): Promise<DecisionRecord[]> {
    const data = await this.get<{ decisions: DecisionRecord[] }>("/decisions/resolved");
    return data.decisions;
  }

  async acknowledgeDecisions(decisionIds: string[]): Promise<void> {
    await this.post("/decisions/acknowledge", { ids: decisionIds });
  }

  // --- Plan Reviews ---

  async recordPlanReview(artifactId: string): Promise<void> {
    await this.post("/plan-reviews", { artifactId });
  }

  async resolvePlanReview(artifactId: string, verdict: "approved" | "revised" | "rejected", feedback?: string): Promise<void> {
    await this.post(`/plan-reviews/${artifactId}/resolve`, { verdict, feedback });
  }

  async getPlanReviewVerdict(artifactId: string): Promise<{ verdict: string; feedback?: string } | null> {
    const data = await this.get<{ verdict?: string; feedback?: string } | null>(`/plan-reviews/${artifactId}/verdict`);
    if (!data || !data.verdict) return null;
    return { verdict: data.verdict, feedback: data.feedback };
  }

  async getPendingPlanReviews(): Promise<PlanReviewRecord[]> {
    const data = await this.get<{ reviews: PlanReviewRecord[] }>("/plan-reviews/pending");
    return data.reviews;
  }

  // --- Engagement & Memory ---

  async recordArtifactReviewed(artifactId: string): Promise<void> {
    await this.post(`/artifacts/${artifactId}/reviewed`);
  }

  async getEngagementMetrics(): Promise<{
    avgReviewLatencyMs: number;
    commentDensity: number;
    approvalRate: number;
    reviewsByType: Record<string, { avgLatencyMs: number; count: number }>;
  }> {
    return this.get("/metrics");
  }

  async recordRejectedApproach(description: string, reason?: string, sourceArtifactId?: string): Promise<void> {
    await this.post("/memory/rejected", { description, reason, sourceArtifactId });
  }

  async recordApprovedPattern(description: string): Promise<void> {
    await this.post("/memory/approved", { description });
  }

  async getSessionMemory(): Promise<{ rejectedApproaches: RejectedApproach[]; approvedPatterns: string[] }> {
    return this.get("/memory");
  }

  // --- Autonomy ---

  async setAutonomyLevel(level: "supervised" | "balanced" | "autonomous"): Promise<void> {
    await this.post("/autonomy", { level });
  }

  async getAutonomyLevel(): Promise<"supervised" | "balanced" | "autonomous"> {
    const data = await this.get<{ level: "supervised" | "balanced" | "autonomous" }>("/autonomy");
    return data.level;
  }

  // --- Feedback polling ---

  async waitForFeedback(timeoutMs = 30000): Promise<void> {
    await fetch(`${this.baseUrl}/wait-feedback?timeout=${timeoutMs}`, {
      signal: AbortSignal.timeout(timeoutMs + 5000), // Extra buffer for network
    });
  }

  // --- Full state ---

  async getFullState() {
    return this.get("/state");
  }

  async forceFlush(): Promise<void> {
    await this.post("/flush");
  }
}
