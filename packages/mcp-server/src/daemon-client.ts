/**
 * DaemonClient — HTTP client that implements IStore by proxying
 * all operations to the shared deepPairing daemon.
 */
import type { Artifact, ArtifactStatus, Comment, TeamPreference, PreflightTrace } from "@deeppairing/shared";
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
  /**
   * Z1 — remember the meta we last registered with so the auto-recover
   * path (on a 404 session_not_registered) can replay register() with
   * the same shape. Without this, a wrapper that survives a daemon
   * restart would re-register without its expectedProjectRoot binding,
   * losing the Y3' guarantee.
   */
  private lastRegisterMeta?: {
    title?: string;
    project?: string;
    expectedProjectRoot?: string;
  };

  constructor(port: number, sessionId: string) {
    this.baseUrl = `http://localhost:${port}/api/internal/sessions/${sessionId}`;
    this.sessionId = sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Z1 — common request path with auto-recover on session_not_registered.
   *
   * Pre-Z1 every call did `await fetch(...); return res.json()` with no
   * status check. Y3' introduced 404s on unregistered sessions (the right
   * fix for the orphan-session class) but the unguarded JSON read meant
   * those 404s flowed back to callers as `data.artifacts === undefined`
   * — silent failure for any wrapper that survived a daemon idle-shutdown.
   *
   * Now: on a 404 + code=session_not_registered, replay register() once
   * with the stored meta and retry the original call. Other non-2xx
   * statuses throw with a structured error so caller bugs surface.
   */
  private async request<T = any>(
    path: string,
    init: RequestInit,
    isRetry = false,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, init);
    if (res.ok) return res.json();

    // Try to parse the structured error body the daemon now returns.
    let body: any = {};
    try { body = await res.clone().json(); } catch {}

    if (
      res.status === 404 &&
      body?.code === "session_not_registered" &&
      !isRetry
    ) {
      // Daemon restarted (or the supervisor killed + respawned it on idle
      // shutdown). The session map is empty server-side; re-register and
      // retry exactly once. Guard against infinite recursion via isRetry.
      await this.register(this.lastRegisterMeta);
      return this.request<T>(path, init, true);
    }

    const msg = body?.error ?? `request failed (${res.status})`;
    throw new Error(`[deepPairing] ${msg}`);
  }

  private async post<T = any>(path: string, body?: any): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  }

  private async get<T = any>(path: string): Promise<T> {
    return this.request<T>(path, {});
  }

  // --- Session lifecycle ---

  /**
   * Y3' — `expectedProjectRoot` is the directory the wrapper was spawned for.
   * The daemon refuses to register (403 project_mismatch) if its own
   * projectRoot doesn't match. Defends against the port-adoption footgun:
   * wrapper for project A connects to a daemon serving project B.
   */
  async register(meta?: {
    title?: string;
    project?: string;
    expectedProjectRoot?: string;
  }): Promise<void> {
    // Z1 — remember meta so the auto-recover path in request() can replay.
    this.lastRegisterMeta = meta;
    const res = await fetch(`${this.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta ?? {}),
    });
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `[deepPairing] Daemon project mismatch (${body.code ?? "project_mismatch"}). ${body.error ?? "Daemon serves a different project. Restart the wrapper."}`,
      );
    }
    if (!res.ok) {
      throw new Error(`[deepPairing] register failed (${res.status})`);
    }
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

  async updateArtifactStatus(
    artifactId: string,
    status: ArtifactStatus,
    reason?: import("./store/store-interface.js").StatusTransitionReason,
  ): Promise<void> {
    await this.post(`/artifacts/${artifactId}/status`, { status, reason });
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

  async resolveDecision(
    decisionId: string,
    optionId: string,
    reasoning?: string,
    prediction?: { confidence?: "low" | "medium" | "high"; predictedOutcome?: string },
  ): Promise<void> {
    await this.post(`/decisions/${decisionId}/resolve`, {
      optionId,
      reasoning,
      confidence: prediction?.confidence,
      predictedOutcome: prediction?.predictedOutcome,
    });
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
    decisionsWithPredictions?: number;
    highStakesDecisions?: number;
  }> {
    return this.get("/metrics");
  }

  async recordRejectedApproach(description: string, reason?: string, sourceArtifactId?: string, concept?: string): Promise<void> {
    await this.post("/memory/rejected", { description, reason, sourceArtifactId, concept });
  }

  async recordApprovedPattern(description: string): Promise<void> {
    await this.post("/memory/approved", { description });
  }

  async getSessionMemory(): Promise<{ rejectedApproaches: RejectedApproach[]; approvedPatterns: string[] }> {
    return this.get("/memory");
  }

  // --- Project context (guardrails + team preferences) ---

  async getProjectGuardrails(): Promise<Array<{ category: string; paths: string[]; rationale: string }>> {
    const data = await this.get<{ guardrails: Array<{ category: string; paths: string[]; rationale: string }> }>("/guardrails");
    return data.guardrails ?? [];
  }

  async getTeamPreferences(): Promise<TeamPreference[]> {
    const data = await this.get<{ preferences: TeamPreference[] }>("/team-preferences");
    return data.preferences ?? [];
  }

  // --- Preflight traces (Z1) ---
  // Y1' shipped trace persistence on FileStore but not on DaemonClient,
  // so the breadcrumb story silently broke in daemon mode. These two
  // wire it through to the new internal /preflight-traces routes.

  async recordPreflightTrace(artifactId: string, trace: PreflightTrace): Promise<void> {
    await this.post(`/preflight-traces/${artifactId}`, { trace });
  }

  async getPreflightTrace(artifactId: string): Promise<PreflightTrace | null> {
    const data = await this.get<{ trace: PreflightTrace | null }>(`/preflight-traces/${artifactId}`);
    return data.trace ?? null;
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

  // --- Cross-session reads (past sessions in the same project) ---

  /** List past sessions for this project. Uses the daemon's public /api/sessions. */
  async listPastSessions(): Promise<Array<{
    id: string;
    createdAt: string;
    lastActivity: string;
    summary: string;
    artifactCount: number;
    hasDecisions: boolean;
  }>> {
    const res = await fetch(`http://localhost:${this.portFromBaseUrl()}/api/sessions`);
    const data = await res.json();
    return data.sessions ?? [];
  }

  /** Load a specific past session's full state. */
  async loadPastSession(sessionId: string): Promise<any> {
    const res = await fetch(`http://localhost:${this.portFromBaseUrl()}/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(`Session ${sessionId} not found`);
    return res.json();
  }

  /** Search across every session in the project. */
  async searchSessions(query: string, limit = 50): Promise<Array<{
    sessionId: string;
    sessionTitle: string;
    artifactId: string;
    artifactType: string;
    title: string;
    excerpt: string;
    score: number;
    matchedVia: string[];
  }>> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const res = await fetch(`http://localhost:${this.portFromBaseUrl()}/api/search?${params}`);
    const data = await res.json();
    return data.results ?? [];
  }

  private portFromBaseUrl(): number {
    // baseUrl = http://localhost:{port}/api/internal/sessions/{sessionId}
    const match = this.baseUrl.match(/localhost:(\d+)/);
    return match ? parseInt(match[1], 10) : 3847;
  }
}
