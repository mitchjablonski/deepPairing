import fs from "node:fs";
import path from "node:path";
import type { Artifact, ArtifactType, ArtifactStatus, Comment } from "@deeppairing/shared";

interface DecisionRecord {
  decisionId: string;
  artifactId: string;
  context: string;
  options: any[];
  response?: { optionId: string; reasoning?: string };
  acknowledged?: boolean;
  createdAt: string;
  resolvedAt?: string;
}

interface PlanReviewRecord {
  artifactId: string;
  verdict?: "approved" | "revised" | "rejected";
  feedback?: string;
  createdAt: string;
  resolvedAt?: string;
}

/**
 * File-based store for deepPairing artifacts, comments, and decisions.
 * Stores data in .deeppairing/ directory within the project root.
 * In-memory cache with debounced disk flush.
 */
export class FileStore {
  private basePath: string;
  private artifacts: Artifact[] = [];
  private comments: Comment[] = [];
  private decisions: Map<string, DecisionRecord> = new Map();
  private planReviews: Map<string, PlanReviewRecord> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string;

  constructor(projectRoot: string, sessionId?: string) {
    this.basePath = path.join(projectRoot, ".deeppairing");
    this.sessionId = sessionId ?? `session_${Date.now()}`;
    this.ensureDir();
    this.load();
  }

  private ensureDir(): void {
    const sessionDir = path.join(this.basePath, "sessions", this.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  private sessionDir(): string {
    return path.join(this.basePath, "sessions", this.sessionId);
  }

  private load(): void {
    try {
      const artFile = path.join(this.sessionDir(), "artifacts.json");
      if (fs.existsSync(artFile)) {
        this.artifacts = JSON.parse(fs.readFileSync(artFile, "utf-8"));
      }
      const cmtFile = path.join(this.sessionDir(), "comments.json");
      if (fs.existsSync(cmtFile)) {
        this.comments = JSON.parse(fs.readFileSync(cmtFile, "utf-8"));
      }
      const decFile = path.join(this.sessionDir(), "decisions.json");
      if (fs.existsSync(decFile)) {
        const arr: DecisionRecord[] = JSON.parse(fs.readFileSync(decFile, "utf-8"));
        this.decisions = new Map(arr.map((d) => [d.decisionId, d]));
      }
      const planFile = path.join(this.sessionDir(), "plan-reviews.json");
      if (fs.existsSync(planFile)) {
        const arr: PlanReviewRecord[] = JSON.parse(fs.readFileSync(planFile, "utf-8"));
        this.planReviews = new Map(arr.map((p) => [p.artifactId, p]));
      }
    } catch {
      // Fresh session — no files to load
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flush();
      this.flushTimer = null;
    }, 100);
  }

  private flush(): void {
    const dir = this.sessionDir();
    fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify(this.artifacts, null, 2));
    fs.writeFileSync(path.join(dir, "comments.json"), JSON.stringify(this.comments, null, 2));
    fs.writeFileSync(path.join(dir, "decisions.json"), JSON.stringify(Array.from(this.decisions.values()), null, 2));
    fs.writeFileSync(path.join(dir, "plan-reviews.json"), JSON.stringify(Array.from(this.planReviews.values()), null, 2));
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
      createdAt: now,
      updatedAt: now,
    };
    this.artifacts.push(artifact);
    this.scheduleFlush();
    return artifact;
  }

  updateArtifactStatus(artifactId: string, status: ArtifactStatus): void {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (art) {
      art.status = status;
      art.updatedAt = new Date().toISOString();
      this.scheduleFlush();
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
  }): Comment {
    const comment: Comment = {
      id: params.id,
      sessionId: this.sessionId,
      target: { artifactId: params.artifactId, ...params.target },
      parentCommentId: null,
      author: params.author,
      content: params.content,
      acknowledged: params.author === "agent",
      createdAt: new Date().toISOString(),
    };
    this.comments.push(comment);
    this.scheduleFlush();
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

  // --- Full state (for web UI hydration) ---

  getFullState() {
    return {
      sessionId: this.sessionId,
      artifacts: this.artifacts,
      comments: this.comments,
      decisions: Array.from(this.decisions.values()),
      planReviews: Array.from(this.planReviews.values()),
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
