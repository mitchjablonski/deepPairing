import fs from "node:fs";
import path from "node:path";
import type { Artifact, ArtifactType, ArtifactStatus, Comment, SessionAnnotation } from "@deeppairing/shared";
import { nanoid } from "nanoid";
import type { IStore, DecisionRecord, PlanReviewRecord, CreateArtifactParams, AddCommentParams, RecordDecisionParams, RejectedApproach } from "./store-interface.js";

export type { DecisionRecord, PlanReviewRecord };

/**
 * File-based store for deepPairing artifacts, comments, and decisions.
 * Stores data in .deeppairing/ directory within the project root.
 * In-memory cache with debounced disk flush.
 */
export class FileStore implements IStore {
  private basePath: string;
  private artifacts: Artifact[] = [];
  private comments: Comment[] = [];
  private decisions: Map<string, DecisionRecord> = new Map();
  private planReviews: Map<string, PlanReviewRecord> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string;
  private autonomyLevel: "supervised" | "balanced" | "autonomous" = "supervised";

  constructor(projectRoot: string, sessionId?: string) {
    this.basePath = path.join(projectRoot, ".deeppairing");
    this.sessionId = sessionId ?? `session_${Date.now()}`;
    // Prevent path traversal via sessionId
    if (this.sessionId.includes("..") || this.sessionId.includes("/") || this.sessionId.includes("\\")) {
      throw new Error("Invalid session ID");
    }
    this.ensureDir();
    this.load();
    this.loadPreferences();
  }

  private ensureDir(): void {
    const sessionDir = path.join(this.basePath, "sessions", this.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  private sessionDir(): string {
    return path.join(this.basePath, "sessions", this.sessionId);
  }

  private loadPreferences(): void {
    const prefsPath = path.join(this.basePath, "preferences.json");
    const prefs = this.loadJsonFile<Record<string, any>>(prefsPath, {});
    if (prefs.autonomyLevel) this.autonomyLevel = prefs.autonomyLevel;
  }

  private load(): void {
    const dir = this.sessionDir();
    this.artifacts = this.loadJsonFile<Artifact[]>(path.join(dir, "artifacts.json"), []);
    this.comments = this.loadJsonFile<Comment[]>(path.join(dir, "comments.json"), []);
    const decArr = this.loadJsonFile<DecisionRecord[]>(path.join(dir, "decisions.json"), []);
    this.decisions = new Map(decArr.map((d) => [d.decisionId, d]));
    const planArr = this.loadJsonFile<PlanReviewRecord[]>(path.join(dir, "plan-reviews.json"), []);
    this.planReviews = new Map(planArr.map((p) => [p.artifactId, p]));
  }

  /** Load a JSON file with graceful error handling */
  private loadJsonFile<T>(filePath: string, fallback: T): T {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err: any) {
      if (err?.code === "ENOENT") return fallback;
      // Corrupted JSON — log warning and back up the corrupt file
      console.error(`[deepPairing] Corrupted file ${filePath}: ${err.message}`);
      try {
        fs.copyFileSync(filePath, filePath + ".corrupt");
      } catch { /* best-effort backup */ }
      return fallback;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flush();
      this.flushTimer = null;
    }, 100);
  }

  /** Atomic write: write to .tmp then rename */
  private atomicWrite(filePath: string, data: unknown): void {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  }

  private flush(): void {
    const dir = this.sessionDir();
    this.atomicWrite(path.join(dir, "artifacts.json"), this.artifacts);
    this.atomicWrite(path.join(dir, "comments.json"), this.comments);
    this.atomicWrite(path.join(dir, "decisions.json"), Array.from(this.decisions.values()));
    this.atomicWrite(path.join(dir, "plan-reviews.json"), Array.from(this.planReviews.values()));
  }

  /** Force an immediate flush — call before process exit */
  forceFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  // --- Artifacts ---

  createArtifact(params: {
    id: string;
    type: ArtifactType;
    title: string;
    content: Record<string, unknown>;
    agentReasoning?: string;
    relatedArtifactIds?: string[];
  }): Artifact {
    const now = new Date().toISOString();
    const artifact: Artifact = {
      id: params.id,
      sessionId: this.sessionId,
      type: params.type,
      version: 1,
      parentId: null,
      title: params.title,
      status: "draft",
      content: params.content,
      agentReasoning: params.agentReasoning ?? null,
      relatedArtifactIds: params.relatedArtifactIds,
      createdAt: now,
      updatedAt: now,
    };
    this.artifacts.push(artifact);
    this.scheduleFlush();
    return artifact;
  }

  renameArtifact(artifactId: string, title: string): void {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (art) {
      art.title = title;
      art.updatedAt = new Date().toISOString();
      this.scheduleFlush();
    }
  }

  updateArtifactStatus(artifactId: string, status: ArtifactStatus): void {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (art) {
      const wasDraft = art.status === "draft";
      const now = new Date().toISOString();
      art.status = status;
      art.updatedAt = now;
      // Append to statusHistory so replay can reconstruct the trail faithfully.
      // Lazy-init so older sessions opt into the richer format on first
      // transition — old records keep working via the fallback in timeline.ts.
      const history = (art as any).statusHistory ?? [];
      if (history.length === 0 && art.createdAt) {
        history.push({ status: "draft", at: art.createdAt });
      }
      history.push({ status, at: now });
      (art as any).statusHistory = history;
      if (wasDraft && status !== "draft") {
        this.recordArtifactReviewed(artifactId);
      }
      this.scheduleFlush();
      this.notifyFeedbackWaiters();
    }
  }

  getArtifacts(): Artifact[] {
    return this.artifacts;
  }

  // --- Comments ---

  addComment(params: {
    id: string;
    artifactId: string;
    content: string;
    author: "human" | "agent";
    target?: Record<string, unknown>;
    intent?: "comment" | "question" | "suggestion";
    parentCommentId?: string | null;
  }): Comment {
    const comment: Comment = {
      id: params.id,
      sessionId: this.sessionId,
      target: { artifactId: params.artifactId, ...params.target },
      parentCommentId: params.parentCommentId ?? null,
      author: params.author,
      content: params.content,
      intent: params.intent,
      answeredByCommentId: null,
      acknowledged: params.author === "agent",
      createdAt: new Date().toISOString(),
    };
    this.comments.push(comment);
    this.scheduleFlush();
    if (params.author === "human") this.notifyFeedbackWaiters();
    return comment;
  }

  getCommentsForArtifact(artifactId: string): Comment[] {
    return this.comments.filter((c) => c.target.artifactId === artifactId);
  }

  getUnacknowledgedComments(): Comment[] {
    return this.comments.filter((c) => !c.acknowledged);
  }

  acknowledgeComments(ids: string[]): void {
    for (const c of this.comments) {
      if (ids.includes(c.id)) c.acknowledged = true;
    }
    this.scheduleFlush();
  }

  getComment(commentId: string): Comment | undefined {
    return this.comments.find((c) => c.id === commentId);
  }

  markCommentAnswered(commentId: string, answerCommentId: string): void {
    const parent = this.comments.find((c) => c.id === commentId);
    if (parent) {
      parent.answeredByCommentId = answerCommentId;
      this.scheduleFlush();
    }
  }

  // --- Decisions ---

  recordDecisionRequest(params: {
    decisionId: string;
    artifactId: string;
    context: string;
    options: any[];
  }): void {
    this.decisions.set(params.decisionId, {
      ...params,
      createdAt: new Date().toISOString(),
    });
    this.scheduleFlush();
  }

  resolveDecision(decisionId: string, optionId: string, reasoning?: string): void {
    const dec = this.decisions.get(decisionId);
    if (dec) {
      dec.response = { optionId, reasoning };
      dec.resolvedAt = new Date().toISOString();
      this.scheduleFlush();
      this.notifyFeedbackWaiters();
    }
  }

  getDecisionResponse(decisionId: string): { optionId: string; reasoning?: string } | null {
    return this.decisions.get(decisionId)?.response ?? null;
  }

  getPendingDecisions(): DecisionRecord[] {
    return Array.from(this.decisions.values()).filter((d) => !d.response);
  }

  getDecision(decisionId: string): DecisionRecord | undefined {
    return this.decisions.get(decisionId);
  }

  getResolvedDecisions(): DecisionRecord[] {
    return Array.from(this.decisions.values()).filter((d) => d.response && !d.acknowledged);
  }

  acknowledgeDecisions(decisionIds: string[]): void {
    for (const id of decisionIds) {
      const dec = this.decisions.get(id);
      if (dec) dec.acknowledged = true;
    }
    this.scheduleFlush();
  }

  // --- Plan Reviews ---

  recordPlanReview(artifactId: string): void {
    this.planReviews.set(artifactId, {
      artifactId,
      createdAt: new Date().toISOString(),
    });
    this.scheduleFlush();
  }

  resolvePlanReview(artifactId: string, verdict: "approved" | "revised" | "rejected", feedback?: string): void {
    const review = this.planReviews.get(artifactId);
    if (review) {
      review.verdict = verdict;
      review.feedback = feedback;
      review.resolvedAt = new Date().toISOString();
      this.scheduleFlush();
      this.notifyFeedbackWaiters();
    }
  }

  getPlanReviewVerdict(artifactId: string): { verdict: string; feedback?: string } | null {
    const review = this.planReviews.get(artifactId);
    if (!review?.verdict) return null;
    return { verdict: review.verdict, feedback: review.feedback };
  }

  getPendingPlanReviews(): PlanReviewRecord[] {
    return Array.from(this.planReviews.values()).filter((p) => !p.verdict);
  }

  // --- Engagement Metrics ---

  private reviewLatencies: { type: string; latencyMs: number }[] = [];

  /** Record that an artifact was reviewed (status changed from draft) */
  recordArtifactReviewed(artifactId: string): void {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (art) {
      const latencyMs = Date.now() - new Date(art.createdAt).getTime();
      this.reviewLatencies.push({ type: art.type, latencyMs });
    }
  }

  getEngagementMetrics(): {
    avgReviewLatencyMs: number;
    commentDensity: number;
    approvalRate: number;
    reviewsByType: Record<string, { avgLatencyMs: number; count: number }>;
  } {
    const reviewed = this.artifacts.filter((a) => a.status !== "draft" && a.status !== "superseded");
    const approved = this.artifacts.filter((a) => a.status === "approved");
    const approvalRate = reviewed.length > 0 ? approved.length / reviewed.length : 1;

    const humanComments = this.comments.filter((c) => c.author === "human" && c.target.artifactId !== "__session__");
    const commentDensity = this.artifacts.length > 0 ? humanComments.length / this.artifacts.length : 0;

    const avgReviewLatencyMs = this.reviewLatencies.length > 0
      ? this.reviewLatencies.reduce((sum, r) => sum + r.latencyMs, 0) / this.reviewLatencies.length
      : 0;

    // Per-type breakdown
    const reviewsByType: Record<string, { totalMs: number; count: number }> = {};
    for (const r of this.reviewLatencies) {
      const entry = reviewsByType[r.type] ?? { totalMs: 0, count: 0 };
      entry.totalMs += r.latencyMs;
      entry.count += 1;
      reviewsByType[r.type] = entry;
    }
    const typeSummary: Record<string, { avgLatencyMs: number; count: number }> = {};
    for (const [type, data] of Object.entries(reviewsByType)) {
      typeSummary[type] = { avgLatencyMs: Math.round(data.totalMs / data.count), count: data.count };
    }

    return { avgReviewLatencyMs: Math.round(avgReviewLatencyMs), commentDensity, approvalRate, reviewsByType: typeSummary };
  }

  // --- Session Memory (persists across sessions) ---

  /**
   * Record a rejected approach so it's never proposed again.
   * Stored in .deeppairing/preferences.json under "rejectedApproaches".
   * Records are enriched objects; legacy string[] entries are migrated on next write.
   */
  recordRejectedApproach(description: string, reason?: string, sourceArtifactId?: string): void {
    const prefs = this.readPreferences();
    const rejected = this.normalizeRejectedApproaches(prefs.rejectedApproaches ?? []);
    const existing = rejected.find((r) => r.description === description);
    if (existing) {
      // If we now have a reason and didn't before, enrich the existing record.
      if (reason && !existing.reason) {
        existing.reason = reason;
        existing.rejectedAt = existing.rejectedAt ?? new Date().toISOString();
        if (sourceArtifactId) existing.sourceArtifactId = sourceArtifactId;
        prefs.rejectedApproaches = rejected;
        this.writePreferences(prefs);
      }
      return;
    }
    rejected.push({
      description,
      reason: reason || undefined,
      rejectedAt: new Date().toISOString(),
      sourceArtifactId,
    });
    prefs.rejectedApproaches = rejected;
    this.writePreferences(prefs);
  }

  /** Migrate legacy string[] into RejectedApproach[] so downstream code sees one shape. */
  private normalizeRejectedApproaches(raw: unknown): RejectedApproach[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) =>
      typeof entry === "string"
        ? { description: entry }
        : { description: String((entry as any)?.description ?? ""), reason: (entry as any)?.reason, rejectedAt: (entry as any)?.rejectedAt, sourceArtifactId: (entry as any)?.sourceArtifactId },
    ).filter((r) => r.description);
  }

  /**
   * Record an approved pattern the human prefers.
   * Stored in .deeppairing/preferences.json under "approvedPatterns".
   */
  recordApprovedPattern(description: string): void {
    const prefs = this.readPreferences();
    const approved: string[] = prefs.approvedPatterns ?? [];
    if (!approved.includes(description)) {
      approved.push(description);
      prefs.approvedPatterns = approved;
      this.writePreferences(prefs);
    }
  }

  /**
   * Get session memory context for the agent.
   * Returns rejected approaches and approved patterns from previous sessions.
   */
  getSessionMemory(): { rejectedApproaches: RejectedApproach[]; approvedPatterns: string[] } {
    const prefs = this.readPreferences();
    return {
      rejectedApproaches: this.normalizeRejectedApproaches(prefs.rejectedApproaches ?? []),
      approvedPatterns: prefs.approvedPatterns ?? [],
    };
  }

  private readPreferences(): Record<string, any> {
    const prefsPath = path.join(this.basePath, "preferences.json");
    return this.loadJsonFile<Record<string, any>>(prefsPath, {});
  }

  private writePreferences(prefs: Record<string, any>): void {
    const prefsPath = path.join(this.basePath, "preferences.json");
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
  }

  // --- Session annotations (learner's replay notes) ---

  /**
   * Annotations live in a separate annotations.json file per session. They
   * never reach the agent — they're the human re-reading their own past
   * work. Keeping the channel separate prevents "learning notes" from
   * accidentally becoming agent context.
   */
  private annotationsPath(): string {
    return path.join(this.sessionDir(), "annotations.json");
  }

  getAnnotations(): SessionAnnotation[] {
    return this.loadJsonFile<SessionAnnotation[]>(this.annotationsPath(), []);
  }

  addAnnotation(params: { targetEventId: string; note: string; tags?: string[] }): SessionAnnotation {
    const annotation: SessionAnnotation = {
      id: `ann_${nanoid(10)}`,
      sessionId: this.sessionId,
      targetEventId: params.targetEventId,
      note: params.note,
      tags: params.tags,
      createdAt: new Date().toISOString(),
    };
    const existing = this.getAnnotations();
    existing.push(annotation);
    fs.writeFileSync(this.annotationsPath(), JSON.stringify(existing, null, 2));
    return annotation;
  }

  deleteAnnotation(annotationId: string): boolean {
    const existing = this.getAnnotations();
    const next = existing.filter((a) => a.id !== annotationId);
    if (next.length === existing.length) return false;
    fs.writeFileSync(this.annotationsPath(), JSON.stringify(next, null, 2));
    return true;
  }

  // --- Autonomy Level ---

  setAutonomyLevel(level: "supervised" | "balanced" | "autonomous"): void {
    this.autonomyLevel = level;
    const prefs = this.readPreferences();
    prefs.autonomyLevel = level;
    this.writePreferences(prefs);
  }

  getAutonomyLevel(): "supervised" | "balanced" | "autonomous" {
    return this.autonomyLevel;
  }

  // --- Feedback notification (for long-poll) ---

  private feedbackWaiters: Array<() => void> = [];

  /** Register a waiter that resolves when new feedback arrives */
  waitForFeedback(timeoutMs = 30000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.feedbackWaiters = this.feedbackWaiters.filter((w) => w !== resolve);
        resolve();
      }, timeoutMs);

      const wrappedResolve = () => {
        clearTimeout(timer);
        resolve();
      };

      this.feedbackWaiters.push(wrappedResolve);
    });
  }

  /** Notify all waiters that feedback has arrived */
  private notifyFeedbackWaiters(): void {
    const waiters = this.feedbackWaiters;
    this.feedbackWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // --- Full state (for web UI hydration) ---

  getFullState() {
    return {
      sessionId: this.sessionId,
      artifacts: this.artifacts,
      comments: this.comments,
      decisions: Array.from(this.decisions.values()),
      planReviews: Array.from(this.planReviews.values()),
      autonomyLevel: this.autonomyLevel,
      sessionMemory: this.getSessionMemory(),
      engagementMetrics: this.getEngagementMetrics(),
    };
  }

  // --- Static methods for multi-session access ---

  static listSessions(projectRoot: string): Array<{
    id: string;
    createdAt: string;
    lastActivity: string;
    summary: string;
    artifactCount: number;
    hasDecisions: boolean;
  }> {
    const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
    if (!fs.existsSync(sessionsDir)) return [];

    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    const sessions: Array<{
      id: string;
      createdAt: string;
      lastActivity: string;
      summary: string;
      artifactCount: number;
      hasDecisions: boolean;
    }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionDir = path.join(sessionsDir, entry.name);
      try {
        const artFile = path.join(sessionDir, "artifacts.json");
        if (!fs.existsSync(artFile)) continue;

        const artifacts: Artifact[] = JSON.parse(fs.readFileSync(artFile, "utf-8"));
        if (artifacts.length === 0) continue;

        const decFile = path.join(sessionDir, "decisions.json");
        const hasDecisions = fs.existsSync(decFile) &&
          JSON.parse(fs.readFileSync(decFile, "utf-8")).length > 0;

        const sorted = [...artifacts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const firstArtifact = sorted[0];
        const lastArtifact = sorted[sorted.length - 1];

        sessions.push({
          id: entry.name,
          createdAt: firstArtifact.createdAt,
          lastActivity: lastArtifact.updatedAt ?? lastArtifact.createdAt,
          summary: firstArtifact.title,
          artifactCount: artifacts.length,
          hasDecisions,
        });
      } catch {
        // Skip corrupted sessions
      }
    }

    return sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  static loadSession(projectRoot: string, sessionId: string) {
    const store = new FileStore(projectRoot, sessionId);
    return store.getFullState();
  }
}
