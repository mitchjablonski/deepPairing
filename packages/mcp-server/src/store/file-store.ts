import fs from "node:fs";
import path from "node:path";
import type { Artifact, ArtifactType, ArtifactStatus, Comment, SessionAnnotation, TeamPreference, Retrospective, RetrospectiveVerdict } from "@deeppairing/shared";
import { parseTeamPreferencesFile } from "@deeppairing/shared";
import { nanoid } from "nanoid";
import { getGlobalStore } from "./global-store.js";
import type { IStore, DecisionRecord, PlanReviewRecord, CreateArtifactParams, AddCommentParams, RecordDecisionParams, RejectedApproach } from "./store-interface.js";

export type { DecisionRecord, PlanReviewRecord };

/**
 * File-based store for deepPairing artifacts, comments, and decisions.
 * Stores data in .deeppairing/ directory within the project root.
 * In-memory cache with debounced disk flush.
 */
export interface ProjectGuardrail {
  /** Short identifier like "migrations" or "workflows". */
  category: string;
  /** Relative path(s) that triggered the guardrail. */
  paths: string[];
  /** Human-readable rationale — why the agent should escalate here. */
  rationale: string;
}

/**
 * Sense the project's sensitive areas by filesystem signals alone — no
 * config. Runs once on FileStore construction; cached per instance. The
 * agent receives these in firstCallHint and knows to stay supervised for
 * changes in these paths even when global autonomy is "autonomous".
 */
function senseProjectGuardrails(projectRoot: string): ProjectGuardrail[] {
  const guardrails: ProjectGuardrail[] = [];
  const exists = (rel: string) => {
    try { return fs.existsSync(path.join(projectRoot, rel)); } catch { return false; }
  };

  const migrationPaths = ["migrations", "db/migrate", "prisma/migrations", "supabase/migrations"].filter(exists);
  if (migrationPaths.length > 0) {
    guardrails.push({
      category: "migrations",
      paths: migrationPaths,
      rationale: "Migrations are hard to reverse — escalate to supervised for changes here.",
    });
  }

  const workflowPath = ".github/workflows";
  if (exists(workflowPath)) {
    guardrails.push({
      category: "workflows",
      paths: [workflowPath],
      rationale: "CI workflows affect every future deploy — escalate for changes here.",
    });
  }

  const infraPaths = ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "infrastructure", "terraform", "k8s", "kubernetes", "helm"].filter(exists);
  if (infraPaths.length > 0) {
    guardrails.push({
      category: "infrastructure",
      paths: infraPaths,
      rationale: "Infrastructure changes affect production surfaces — escalate here.",
    });
  }

  const secretPaths = [".env", ".env.local", ".env.production", "config/secrets.yml"].filter(exists);
  if (secretPaths.length > 0) {
    guardrails.push({
      category: "secrets",
      paths: secretPaths,
      rationale: "Secret files must never leak into the session or a commit — escalate here.",
    });
  }

  return guardrails;
}

/**
 * Load and validate `.deeppairing/team.json`. Returns [] for any failure
 * mode (missing, unreadable, malformed) — team prefs are advisory; we never
 * crash a session over a broken file. The caller can log if it cares.
 */
/**
 * Strip JSONC-style `//` line comments so team.json can ship with a header
 * explaining what the kinds mean. Naive but good enough: strips a leading
 * `//...` only when the comment starts at the beginning of the line
 * (after whitespace) — avoids clobbering `//` inside strings like URLs.
 */
function stripJsoncComments(src: string): string {
  return src
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

function loadTeamPreferences(basePath: string): TeamPreference[] {
  const filePath = path.join(basePath, "team.json");
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(stripJsoncComments(fs.readFileSync(filePath, "utf-8")));
    const parsed = parseTeamPreferencesFile(raw);
    if (!parsed) {
      console.warn(`[deepPairing] team.json failed schema validation; ignoring`);
      return [];
    }
    return parsed.preferences;
  } catch (err) {
    console.warn(`[deepPairing] Could not load team.json: ${err}`);
    return [];
  }
}

export class FileStore implements IStore {
  private basePath: string;
  private projectHint: string;
  private guardrails: ProjectGuardrail[];
  private teamPreferences: TeamPreference[];
  private artifacts: Artifact[] = [];
  private comments: Comment[] = [];
  private decisions: Map<string, DecisionRecord> = new Map();
  private planReviews: Map<string, PlanReviewRecord> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string;
  private autonomyLevel: "supervised" | "balanced" | "autonomous" = "supervised";

  constructor(projectRoot: string, sessionId?: string) {
    this.basePath = path.join(projectRoot, ".deeppairing");
    // Project hint for the global philosophy ledger — basename only so the
    // ledger stays portable across machines (never store absolute paths).
    this.projectHint = path.basename(projectRoot);
    // J6: sense filesystem signals for guardrails (migrations, workflows,
    // infra, secrets). The agent gets these on first tool call so it knows
    // to escalate for changes in those paths even when global autonomy is
    // "autonomous" — zero user configuration.
    this.guardrails = senseProjectGuardrails(projectRoot);
    // N6.2: load committable team preferences from .deeppairing/team.json.
    // Cached for the lifetime of the FileStore — the file is meant to be
    // edited via PR, so a session reload is the right reload point.
    this.teamPreferences = loadTeamPreferences(this.basePath);
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
    parentId?: string | null;
    version?: number;
  }): Artifact {
    const now = new Date().toISOString();
    const artifact: Artifact = {
      id: params.id,
      sessionId: this.sessionId,
      type: params.type,
      version: params.version ?? 1,
      parentId: params.parentId ?? null,
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

  /**
   * U0.1 — server-side dedupe window. Field bug: a single comment posted
   * ~13 times in a row because the client's `if (sending) return` guard read
   * stale React state during rapid Enter presses, and there was no
   * server-side gate. Two duplicates within DEDUPE_WINDOW_MS for the same
   * (artifact, author, content, parent) tuple collapse to one — we return
   * the original comment so the caller's optimistic UI still gets a record.
   *
   * 5 seconds is the sweet spot: catches every rapid-fire mode I've seen
   * (double-Enter, retry-on-timeout, websocket loop), short enough that a
   * user genuinely posting the same content twice on purpose isn't blocked
   * (wait 6s and try again).
   */
  private static readonly DEDUPE_WINDOW_MS = 5000;

  addComment(params: {
    id: string;
    artifactId: string;
    content: string;
    author: "human" | "agent";
    target?: Record<string, unknown>;
    intent?: "comment" | "question" | "suggestion";
    parentCommentId?: string | null;
  }): Comment {
    const now = Date.now();
    const parentKey = params.parentCommentId ?? "";
    const dupe = this.comments.find((c) => {
      if (c.author !== params.author) return false;
      if (c.target.artifactId !== params.artifactId) return false;
      if (c.content !== params.content) return false;
      if ((c.parentCommentId ?? "") !== parentKey) return false;
      const t = new Date(c.createdAt).getTime();
      return Number.isFinite(t) && now - t < FileStore.DEDUPE_WINDOW_MS;
    });
    if (dupe) {
      // Return the existing comment so the caller's response/broadcast logic
      // still wires the UI to a valid record. The duplicate POST silently
      // resolves to the original — invisible to the user, gold for the field
      // bug we're closing.
      return dupe;
    }

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
      createdAt: new Date(now).toISOString(),
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
    stakes?: "low" | "medium" | "high";
  }): void {
    this.decisions.set(params.decisionId, {
      ...params,
      createdAt: new Date().toISOString(),
    });
    this.scheduleFlush();
  }

  resolveDecision(
    decisionId: string,
    optionId: string,
    reasoning?: string,
    prediction?: { confidence?: "low" | "medium" | "high"; predictedOutcome?: string },
  ): void {
    const dec = this.decisions.get(decisionId);
    if (dec) {
      dec.response = {
        optionId,
        reasoning,
        confidence: prediction?.confidence,
        predictedOutcome: prediction?.predictedOutcome,
      };
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
    decisionsWithPredictions: number;
    highStakesDecisions: number;
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

    // K2: craft-development signals — how often the user captures predictions
    // and how often the agent flags decisions as high-stakes.
    let decisionsWithPredictions = 0;
    let highStakesDecisions = 0;
    for (const d of this.decisions.values()) {
      const r = d.response as any;
      if (r && (r.confidence || r.predictedOutcome)) decisionsWithPredictions++;
      if ((d as any).stakes === "high") highStakesDecisions++;
    }

    return {
      avgReviewLatencyMs: Math.round(avgReviewLatencyMs),
      commentDensity,
      approvalRate,
      reviewsByType: typeSummary,
      decisionsWithPredictions,
      highStakesDecisions,
    };
  }

  // --- Session Memory (persists across sessions) ---

  /**
   * Record a rejected approach so it's never proposed again.
   * Stored in .deeppairing/preferences.json under "rejectedApproaches".
   * Records are enriched objects; legacy string[] entries are migrated on next write.
   */
  recordRejectedApproach(description: string, reason?: string, sourceArtifactId?: string, concept?: string): void {
    // Mirror into the user-global philosophy ledger. The session-scoped
    // preferences.json remains the source of truth for THIS project's
    // pre-flight; the global ledger is additive context for future sessions
    // across all projects.
    const conceptKey = concept?.trim() || description.trim();
    if (conceptKey) {
      try {
        getGlobalStore().recordInstance(conceptKey, {
          project: this.projectHint,
          sessionId: this.sessionId,
          verdict: "rejected",
          reason,
          description,
        });
      } catch {
        // Non-fatal — losing a ledger append doesn't break the session.
      }
    }

    const prefs = this.readPreferences();
    const rejected = this.normalizeRejectedApproaches(prefs.rejectedApproaches ?? []);
    const existing = rejected.find((r) => r.description === description);
    if (existing) {
      // Enrich incrementally — each new signal (reason, concept, source) is
      // additive so we never overwrite prior context with a blank update.
      let changed = false;
      if (reason && !existing.reason) { existing.reason = reason; changed = true; }
      if (concept && !existing.concept) { existing.concept = concept; changed = true; }
      if (sourceArtifactId && !existing.sourceArtifactId) { existing.sourceArtifactId = sourceArtifactId; changed = true; }
      if (changed) {
        existing.rejectedAt = existing.rejectedAt ?? new Date().toISOString();
        prefs.rejectedApproaches = rejected;
        this.writePreferences(prefs);
      }
      return;
    }
    rejected.push({
      description,
      reason: reason || undefined,
      concept: concept || undefined,
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
        : {
            description: String((entry as any)?.description ?? ""),
            reason: (entry as any)?.reason,
            rejectedAt: (entry as any)?.rejectedAt,
            sourceArtifactId: (entry as any)?.sourceArtifactId,
            concept: (entry as any)?.concept,
          },
    ).filter((r) => r.description);
  }

  /**
   * Record an approved pattern the human prefers.
   * Stored in .deeppairing/preferences.json under "approvedPatterns".
   */
  recordApprovedPattern(description: string): void {
    // Mirror into global philosophy ledger (same rationale as rejection path).
    if (description.trim()) {
      try {
        getGlobalStore().recordInstance(description, {
          project: this.projectHint,
          sessionId: this.sessionId,
          verdict: "approved",
          description,
        });
      } catch {
        // Non-fatal
      }
    }

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

  getProjectGuardrails(): ProjectGuardrail[] {
    return this.guardrails;
  }

  getTeamPreferences(): TeamPreference[] {
    return this.teamPreferences;
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

  /**
   * Search every session in the project for artifacts matching a free-text query.
   * Scoring (simple, transparent):
   *   concept name match   × 3
   *   rejected-approach    × 2
   *   title match          × 2
   *   content match        × 1
   * Case-insensitive substring across all token positions. Capped at {@link limit}
   * results total so the UI stays fast on large projects.
   */
  static searchAll(
    projectRoot: string,
    query: string,
    limit = 50,
  ): Array<{
    sessionId: string;
    sessionTitle: string;
    artifactId: string;
    artifactType: string;
    title: string;
    excerpt: string;
    score: number;
    matchedVia: Array<"concept" | "title" | "content" | "rejected">;
  }> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: Array<{
      sessionId: string;
      sessionTitle: string;
      artifactId: string;
      artifactType: string;
      title: string;
      excerpt: string;
      score: number;
      matchedVia: Array<"concept" | "title" | "content" | "rejected">;
    }> = [];

    const sessions = FileStore.listSessions(projectRoot);
    for (const session of sessions) {
      const sessionDir = path.join(projectRoot, ".deeppairing", "sessions", session.id);
      const artFile = path.join(sessionDir, "artifacts.json");
      if (!fs.existsSync(artFile)) continue;
      let artifacts: Artifact[];
      try {
        artifacts = JSON.parse(fs.readFileSync(artFile, "utf-8"));
      } catch {
        continue;
      }

      // Pull rejected approaches from preferences.json for this project
      const prefsFile = path.join(projectRoot, ".deeppairing", "preferences.json");
      let rejected: Array<{ description?: string; concept?: string; reason?: string; sourceArtifactId?: string }> = [];
      try {
        if (fs.existsSync(prefsFile)) {
          const prefs = JSON.parse(fs.readFileSync(prefsFile, "utf-8"));
          const raw = prefs.rejectedApproaches ?? [];
          rejected = Array.isArray(raw)
            ? raw.map((r: any) => (typeof r === "string" ? { description: r } : r))
            : [];
        }
      } catch {}

      for (const artifact of artifacts) {
        const matchedVia = new Set<"concept" | "title" | "content" | "rejected">();
        let score = 0;

        // Title
        if (artifact.title && artifact.title.toLowerCase().includes(q)) {
          score += 2;
          matchedVia.add("title");
        }

        // Concept (reasoning artifacts)
        const concept = (artifact.content as any)?.concept;
        if (concept?.name && String(concept.name).toLowerCase().includes(q)) {
          score += 3;
          matchedVia.add("concept");
        }

        // Rejected approach tied to this artifact (or matching the query directly)
        for (const rej of rejected) {
          const matchesArtifact = rej.sourceArtifactId === artifact.id;
          const desc = (rej.description ?? "").toLowerCase();
          const reason = (rej.reason ?? "").toLowerCase();
          const conceptStr = (rej.concept ?? "").toLowerCase();
          const hit = desc.includes(q) || reason.includes(q) || conceptStr.includes(q);
          if (matchesArtifact && hit) {
            score += 2;
            matchedVia.add("rejected");
          }
        }

        // Content fallback — stringify and substring-check
        let contentBlob = "";
        try {
          contentBlob = JSON.stringify(artifact.content ?? {}).toLowerCase();
        } catch {}
        if (contentBlob.includes(q)) {
          score += 1;
          matchedVia.add("content");
        }

        if (score === 0) continue;

        // Excerpt: short context window around the first match in content/title
        const source = artifact.title + " — " + contentBlob;
        const idx = source.indexOf(q);
        const excerpt =
          idx >= 0
            ? source
                .slice(Math.max(0, idx - 40), idx + q.length + 80)
                .replace(/\s+/g, " ")
                .trim()
            : artifact.title;

        results.push({
          sessionId: session.id,
          sessionTitle: session.summary,
          artifactId: artifact.id,
          artifactType: artifact.type,
          title: artifact.title,
          excerpt,
          score,
          matchedVia: Array.from(matchedVia),
        });
      }
    }

    // Sort by score desc, then recency (session.lastActivity is already in
    // listSessions order; we preserve insertion order via stable sort).
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * N3.3: find the user's past predictions on similar past decisions.
   * Source: resolved decisions with a non-empty `response.predictedOutcome`
   * (captured by the companion UI on high-stakes decisions).
   *
   * Match is concept-token overlap between `query` and each past decision's
   * artifact title + context + chosen option text. We don't use exact match
   * because the phrasing of a decision evolves; we do cap at tokens ≥4 chars
   * to keep the signal-to-noise reasonable.
   */
  static findPastPredictions(
    projectRoot: string,
    query: string,
    opts: { excludeArtifactId?: string; limit?: number } = {},
  ): Array<{
    sessionId: string;
    sessionTitle?: string;
    artifactId: string;
    artifactTitle: string;
    context: string;
    decisionId: string;
    chosenOptionTitle: string;
    predictedOutcome: string;
    confidence?: "low" | "medium" | "high";
    resolvedAt: string;
    daysAgo: number;
    retrospective?: Retrospective;
  }> {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter((t) => t.length >= 4);
    if (tokens.length === 0) return [];

    const limit = opts.limit ?? 3;
    const now = Date.now();

    const out: ReturnType<typeof FileStore.findPastPredictions> = [];
    const sessions = FileStore.listSessions(projectRoot);
    for (const session of sessions) {
      const sessionDir = path.join(projectRoot, ".deeppairing", "sessions", session.id);
      const artFile = path.join(sessionDir, "artifacts.json");
      const decFile = path.join(sessionDir, "decisions.json");
      if (!fs.existsSync(artFile) || !fs.existsSync(decFile)) continue;

      let artifacts: Artifact[];
      let decisions: DecisionRecord[];
      try {
        artifacts = JSON.parse(fs.readFileSync(artFile, "utf-8"));
        decisions = JSON.parse(fs.readFileSync(decFile, "utf-8"));
      } catch {
        continue;
      }

      for (const dec of decisions) {
        if (!dec.response?.predictedOutcome) continue;
        if (opts.excludeArtifactId && dec.artifactId === opts.excludeArtifactId) continue;
        const artifact = artifacts.find((a) => a.id === dec.artifactId);
        if (!artifact) continue;

        const haystack = (
          artifact.title + " " +
          (dec.context ?? "") + " " +
          ((dec.options ?? []).find((o: any) => o.id === dec.response!.optionId)?.title ?? "") + " " +
          ((dec.options ?? []).find((o: any) => o.id === dec.response!.optionId)?.description ?? "")
        ).toLowerCase();

        const hits = tokens.filter((t) => haystack.includes(t));
        // Require majority of tokens to match so we don't surface unrelated decisions.
        if (hits.length < Math.ceil(tokens.length / 2)) continue;

        const chosen = (dec.options ?? []).find((o: any) => o.id === dec.response!.optionId);
        const resolvedAt = dec.resolvedAt ?? dec.createdAt;
        const daysAgo = Math.max(0, Math.floor((now - new Date(resolvedAt).getTime()) / (24 * 60 * 60 * 1000)));

        // Hydrate any existing retrospective for this decision so the
        // breadcrumb can render the verdict alongside the prediction.
        const retrosPath = path.join(sessionDir, "retrospectives.json");
        let retrospective: Retrospective | undefined;
        try {
          if (fs.existsSync(retrosPath)) {
            const retros: Retrospective[] = JSON.parse(fs.readFileSync(retrosPath, "utf-8"));
            retrospective = retros.find((r) => r.decisionId === dec.decisionId);
          }
        } catch {}

        out.push({
          sessionId: session.id,
          sessionTitle: session.summary,
          artifactId: dec.artifactId,
          artifactTitle: artifact.title,
          context: dec.context ?? "",
          decisionId: dec.decisionId,
          chosenOptionTitle: chosen?.title ?? dec.response!.optionId,
          predictedOutcome: dec.response!.predictedOutcome,
          confidence: (dec.response as any).confidence,
          resolvedAt,
          daysAgo,
          retrospective,
        });
      }
    }

    // Newest first — the user likely remembers recent predictions better.
    return out.sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt)).slice(0, limit);
  }

  /**
   * P2 — write a retrospective for a decision that was made in some past
   * session. Walks sessions to find the one owning the decisionId; replaces
   * any existing retrospective for that decision (users can change their
   * minds as more evidence comes in).
   *
   * Returns the hydrated retrospective on success, or null if no session
   * owns the decisionId (caller should 404).
   */
  static addRetrospective(
    projectRoot: string,
    params: { decisionId: string; verdict: RetrospectiveVerdict; note?: string },
  ): { retrospective: Retrospective; sessionId: string } | null {
    const sessions = FileStore.listSessions(projectRoot);
    for (const session of sessions) {
      const sessionDir = path.join(projectRoot, ".deeppairing", "sessions", session.id);
      const decFile = path.join(sessionDir, "decisions.json");
      if (!fs.existsSync(decFile)) continue;
      let decisions: DecisionRecord[];
      try {
        decisions = JSON.parse(fs.readFileSync(decFile, "utf-8"));
      } catch {
        continue;
      }
      if (!decisions.some((d) => d.decisionId === params.decisionId)) continue;

      const retrospective: Retrospective = {
        id: `retro_${nanoid(10)}`,
        decisionId: params.decisionId,
        verdict: params.verdict,
        note: params.note?.trim() || undefined,
        createdAt: new Date().toISOString(),
      };

      const retrosPath = path.join(sessionDir, "retrospectives.json");
      let existing: Retrospective[] = [];
      try {
        if (fs.existsSync(retrosPath)) {
          existing = JSON.parse(fs.readFileSync(retrosPath, "utf-8"));
        }
      } catch {}
      const filtered = existing.filter((r) => r.decisionId !== params.decisionId);
      filtered.push(retrospective);
      fs.writeFileSync(retrosPath, JSON.stringify(filtered, null, 2));

      return { retrospective, sessionId: session.id };
    }
    return null;
  }
}
