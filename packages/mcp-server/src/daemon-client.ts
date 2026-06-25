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
import { projectHashOf } from "./project-root.js";

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

  // CC6 — when constructed with the wrapper's projectRoot we can stamp
  // every outbound request with X-Project-Hash. Today this is belt-and-
  // suspenders: the AA4 middleware enforces the header on a single global
  // mount so /api/internal/* + /api/ledger/digest both go through the
  // gate. If a future refactor moves public routes under a hashed mount
  // (or splits mounts), the header is already on the wire — no surprise
  // 403s. Optional so test fixtures that don't care about hashes still
  // work (`new DaemonClient(port, sid)` keeps its prior signature).
  private readonly projectHash: string | undefined;
  // II1 — Bearer token the daemon minted on startup and wrote into
  // .deeppairing/daemon.json (mode 0600). The wrapper picks it up via
  // ensureDaemon and passes it in here. Stamped on every wire call to
  // /api/internal/* as `Authorization: Bearer <token>` so a malicious
  // local process without read access to daemon.json can't impersonate
  // the wrapper. Optional for test fixtures that construct DaemonClient
  // directly against a route harness with no auth gate.
  //
  // IV1 — mutable (was readonly). The daemon re-mints its bearer token
  // on every fresh spawn; if the daemon idle-shuts and respawns mid-
  // conversation the wrapper's cached token is now stale. The 401
  // recovery path below re-reads daemon.json and rotates this field
  // so subsequent calls authenticate against the new daemon.
  private authToken: string | undefined;
  /**
   * IV1 — projectRoot is the directory the daemon's daemon.json lives
   * under. Held here (not just as a projectHash) so the 401 recovery
   * path can re-read .deeppairing/daemon.json and pick up the new
   * authToken after a daemon respawn.
   */
  private readonly projectRoot: string | undefined;

  constructor(port: number, sessionId: string, expectedProjectRoot?: string, authToken?: string) {
    this.baseUrl = `http://localhost:${port}/api/internal/sessions/${sessionId}`;
    this.sessionId = sessionId;
    this.projectHash = expectedProjectRoot ? projectHashOf(expectedProjectRoot) : undefined;
    this.authToken = authToken;
    this.projectRoot = expectedProjectRoot;
  }

  /**
   * IV1 — re-read .deeppairing/daemon.json and rotate the cached
   * authToken if the file's token has changed. Returns true when the
   * token was actually updated (so the caller knows a retry has a
   * reason to succeed). Best-effort: if daemon.json is missing,
   * unreadable, or token-less, returns false and the original 401
   * propagates to the caller.
   *
   * Threat model: this read happens AFTER a 401 from a previously-
   * working endpoint — the daemon has clearly respawned. The path
   * the wrapper reads is the same path the daemon writes under the
   * same uid (III3's 0600 mode), so there's no new auth-bypass
   * surface introduced.
   */
  private async refreshAuthTokenFromDaemonInfo(): Promise<boolean> {
    if (!this.projectRoot) return false;
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const infoPath = path.join(this.projectRoot, ".deeppairing", "daemon.json");
      if (!fs.existsSync(infoPath)) return false;
      const raw = fs.readFileSync(infoPath, "utf-8");
      const info = JSON.parse(raw) as { authToken?: string };
      if (typeof info.authToken !== "string" || !info.authToken) return false;
      if (info.authToken === this.authToken) return false;
      this.authToken = info.authToken;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Phase 3 — recover from a severed socket (a host sleep killed the
   * connection, and the daemon may have idle-shut and respawned on a
   * DIFFERENT port). Re-adopt our project's daemon via ensureDaemon
   * (probe → projectRoot-matched adopt → spawn), rotate the token + port,
   * and re-register the session. Returns false (so the caller surfaces a
   * clear error) when there's no projectRoot to recover against, when the
   * register binding lacks expectedProjectRoot (AA6.4 — never silently
   * rebind to a possibly-wrong project), or when re-adoption fails.
   */
  private async recoverDaemonConnection(): Promise<boolean> {
    if (!this.projectRoot) return false;
    if (this.lastRegisterMeta && !this.lastRegisterMeta.expectedProjectRoot) return false;
    try {
      // Dynamic import — avoids any static cycle with daemon-lifecycle.
      const { ensureDaemon } = await import("./daemon-lifecycle.js");
      const info = await ensureDaemon(this.projectRoot);
      if (!info) return false;
      if (info.authToken) this.authToken = info.authToken;
      // The daemon may have respawned on a new port — rebuild baseUrl.
      this.baseUrl = `http://localhost:${info.port}/api/internal/sessions/${this.sessionId}`;
      await this.register(this.lastRegisterMeta);
      return true;
    } catch {
      return false;
    }
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
    // CC6 — stamp X-Project-Hash on every wire call when the wrapper
    // knows its projectRoot. II1 — also stamp Authorization with the
    // daemon's bearer token when available, so /api/internal/* accepts
    // the call. Headers merged additively so anything the caller passed
    // (e.g. Content-Type from this.post) survives.
    const extraHeaders: Record<string, string> = {};
    if (this.projectHash) extraHeaders["X-Project-Hash"] = this.projectHash;
    if (this.authToken) extraHeaders["Authorization"] = `Bearer ${this.authToken}`;
    const initWithHash = {
      ...init,
      headers: { ...(init.headers ?? {}), ...extraHeaders },
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, initWithHash);
    } catch (err: any) {
      // AbortError/TimeoutError are the expected long-poll end shape
      // (waitForFeedback relies on it) — propagate unchanged.
      if (err?.name === "AbortError" || err?.name === "TimeoutError") throw err;
      // A network-level throw means the socket to the daemon died — classically
      // a host sleep severed it (the daemon may also have idle-shut and
      // respawned on a different port). Transparently re-adopt + retry once
      // before surfacing anything, so a tool call doesn't fail with a raw
      // "socket connection closed unexpectedly".
      if (!isRetry) {
        const recovered = await this.recoverDaemonConnection();
        if (recovered) return this.request<T>(path, init, true);
      }
      throw new Error(
        `[deepPairing] daemon connection lost (likely after host sleep). ` +
        `Reconnect failed — run \`npx deeppairing doctor\` to diagnose, or restart Claude Code.`,
      );
    }
    if (res.ok) return res.json();

    // Try to parse the structured error body the daemon now returns.
    let body: any = {};
    try { body = await res.clone().json(); } catch {}

    // IV1 — 401 recovery on stale token after daemon respawn. The
    // daemon re-mints its bearer on every fresh spawn (daemon.ts);
    // the wrapper's cached token is now wrong. Re-read daemon.json,
    // rotate the cached token, retry once. Distinct from the 404
    // path (which means "the SESSION is unknown"); a 401 means "the
    // TOKEN is wrong" — both can happen in the same wall-clock
    // second after a respawn (daemon writes daemon.json before its
    // session map is populated). Guarded by isRetry so we never
    // double-rotate; the SECOND 401 propagates so the caller sees
    // an actionable error rather than an infinite loop.
    if (
      res.status === 401 &&
      body?.code === "daemon_auth_required" &&
      !isRetry
    ) {
      const rotated = await this.refreshAuthTokenFromDaemonInfo();
      if (rotated) {
        return this.request<T>(path, init, true);
      }
      // No new token available — fall through to the throw below.
    }

    if (
      res.status === 404 &&
      body?.code === "session_not_registered" &&
      !isRetry
    ) {
      // Daemon restarted (or the supervisor killed + respawned it on idle
      // shutdown). The session map is empty server-side; re-register and
      // retry exactly once. Guard against infinite recursion via isRetry.
      //
      // AA6.4 — refuse to silently rebind when the original register
      // didn't carry expectedProjectRoot. Without that binding, the
      // retry could land against a different daemon (port re-adoption
      // by another project's daemon) and silently bind to the wrong
      // project — breaks the Y3' guarantee. Production wrappers
      // (standalone.ts) always pass expectedProjectRoot; this guard
      // catches non-standalone callers (tests, future plugin entry
      // points, IDE extensions) that omit it.
      if (this.lastRegisterMeta && !this.lastRegisterMeta.expectedProjectRoot) {
        throw new Error(
          `[deepPairing] retry refused — register meta lacks expectedProjectRoot binding. ` +
          `Y3' protection requires the wrapper to declare which project it expects so the daemon can 403 on mismatch. ` +
          `Pass expectedProjectRoot to register() before issuing requests.`,
        );
      }
      await this.register(this.lastRegisterMeta);
      // AA2 — notify the daemon (which broadcasts daemon_resumed to WS
      // clients) so the companion UI knows to refetch state. Fire-and-
      // forget — recovery shouldn't fail just because the broadcast
      // didn't land.
      void fetch(`${this.baseUrl}/recovered`, { method: "POST" }).catch(() => {});
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
    // CC6 — register() bypasses request() (it has its own 403 handling)
    // so add the X-Project-Hash header here too. Without this, the very
    // first call from the wrapper would skip the gate.
    // II1 — same story for the Bearer token: register() is itself an
    // internal route and the auth middleware sees it first, so the token
    // has to be on the very first call or the wrapper 401s before it
    // ever gets a chance to register.
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.projectHash) headers["X-Project-Hash"] = this.projectHash;
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;
    let res = await fetch(`${this.baseUrl}/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(meta ?? {}),
    });
    // IV1 — register() also needs 401 recovery. When the 404-recovery
    // path in request() calls register() against a respawned daemon,
    // the wrapper's cached token is still stale until the rotate
    // succeeds — and register() is itself the first internal call
    // after the rotate-trigger. Re-read daemon.json and retry once
    // if we get 401 here; otherwise the recovery loop is incomplete.
    if (res.status === 401) {
      const rotated = await this.refreshAuthTokenFromDaemonInfo();
      if (rotated) {
        if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;
        res = await fetch(`${this.baseUrl}/register`, {
          method: "POST",
          headers,
          body: JSON.stringify(meta ?? {}),
        });
      }
    }
    if (res.status === 403) {
      // AA2 — clear cached meta on project mismatch. Pre-AA2 the meta
      // was assigned BEFORE this throw, so a 403 cached the bad meta;
      // the next 404 retry would replay register() with that same bad
      // meta against the same wrong daemon and 403 again, in a loop.
      // Now the cache is only set on success (below), and a mismatch
      // explicitly clears any prior cached value so the wrapper can't
      // unintentionally resurrect a stale binding.
      this.lastRegisterMeta = undefined;
      const body = await res.json().catch(() => ({}));
      // DD4 — two 403 codes can fire here for the same root cause:
      //   - "project_mismatch" — /register's own check (expectedProjectRoot
      //     vs daemon projectRoot), with a rich `error` field.
      //   - "project_hash_mismatch" — the global X-Project-Hash middleware
      //     (CC6 stamps the hash on register itself). Fires FIRST, so the
      //     /register handler's nicer message is unreachable in CC6+
      //     daemon mode. Same root cause, different copy.
      // Branch on the code so the user-visible message is actually
      // actionable in both cases.
      const code = body.code ?? "project_mismatch";
      const explanation =
        code === "project_hash_mismatch"
          ? "The daemon on this port serves a different project. Either restart the wrapper to bind to the right daemon, or run `npx deeppairing doctor --fix` to evict the squatter."
          : (body.error ?? "Daemon serves a different project. Restart the wrapper.");
      throw new Error(
        `[deepPairing] Daemon project mismatch (${code}). ${explanation}`,
      );
    }
    if (!res.ok) {
      throw new Error(`[deepPairing] register failed (${res.status})`);
    }
    // AA2 — cache meta ONLY after a successful register. The recover path
    // in request() replays this on 404 session_not_registered.
    this.lastRegisterMeta = meta;
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

  /** F1 — fire-and-forget metric the daemon can't tap from its own broadcast
   *  (the wrapper's broadcast is a no-op in standalone). Never throws. */
  async recordMetric(event: { kind: "preflight_block"; source: "session" | "team" }): Promise<void> {
    try { await this.post(`/metrics`, event); } catch { /* telemetry — never break a tool call */ }
  }

  async markCommentHumanResolved(commentId: string, resolvedAt?: string): Promise<void> {
    await this.post(`/comments/${commentId}/mark-resolved`, { resolvedAt });
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

  // AA1 — typed-object signatures matching IStore. Wire shape unchanged
  // (the daemon's /memory/* routes already accepted this object).
  async recordRejectedApproach(params: {
    description: string;
    reason?: string;
    sourceArtifactId?: string;
    concept?: string;
  }): Promise<void> {
    await this.post("/memory/rejected", params);
  }

  async recordApprovedPattern(params: { description: string; concept?: string }): Promise<void> {
    await this.post("/memory/approved", params);
  }

  async overrideRejectedApproach(params: { description?: string; concept?: string }): Promise<{ retired: number }> {
    return this.post("/memory/override", params);
  }

  async getSessionMemory(): Promise<{ rejectedApproaches: RejectedApproach[]; approvedPatterns: string[] }> {
    return this.get("/memory");
  }

  // III8 — cross-project ledger publish opt-in. Proxies to the daemon
  // which delegates to the per-session FileStore.
  async setGlobalLedgerPublish(enabled: boolean): Promise<void> {
    await this.post("/memory/global-publish", { enabled });
  }

  async getGlobalLedgerPublish(): Promise<boolean> {
    const data = await this.get<{ enabled: boolean }>("/memory/global-publish");
    return data.enabled === true;
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

  /**
   * AA2 — long-poll for human feedback. Pre-AA2 this hand-rolled `fetch`
   * and ignored the response status entirely, which silently swallowed
   * any failure (including the Z1-introduced 404 session_not_registered
   * when a daemon idle-shutdown lands mid-poll). Now routed through
   * `request()` so the auto-recover path fires; on AbortError (timeout)
   * we resolve cleanly instead of throwing — the agent's polling loop
   * will call check_feedback again.
   */
  async waitForFeedback(timeoutMs = 30000): Promise<void> {
    try {
      await this.request<unknown>(
        `/wait-feedback?timeout=${timeoutMs}`,
        { signal: AbortSignal.timeout(timeoutMs + 5000) },
      );
    } catch (err: any) {
      // Timeout or daemon-side cancellation is the EXPECTED end-of-poll
      // shape — the long-poll either resolved or hit its budget. Don't
      // throw at the caller; let them call check_feedback again.
      if (err?.name === "AbortError" || err?.name === "TimeoutError") return;
      // Anything else (network down, 5xx) bubbles up as a structured
      // [deepPairing] error from request().
      throw err;
    }
  }

  // --- Full state ---

  async getFullState() {
    return this.get("/state");
  }

  async forceFlush(): Promise<void> {
    await this.post("/flush");
  }

  // --- Cross-session reads (past sessions in the same project) ---

  /**
   * AA2 — sibling of request() for the daemon's project-public routes
   * (`/api/sessions`, `/api/search`). These aren't session-scoped so they
   * don't need the session_not_registered retry — but they DO need the
   * status check that the pre-AA2 hand-rolled fetches were missing. A
   * 5xx from the daemon used to flow back as `data.results === undefined`
   * and the caller fell back to `[]` silently. Now non-2xx throws.
   */
  private async requestPublic<T = any>(path: string): Promise<T> {
    // CC6 — same X-Project-Hash stamp on the public-route fetches. Today
    // these go through the same global middleware so the header is
    // belt-and-suspenders; if /api/ledger/digest or /api/sessions ever
    // moves under a hashed mount the call won't 403.
    const init: RequestInit = this.projectHash
      ? { headers: { "X-Project-Hash": this.projectHash } }
      : {};
    const res = await fetch(`http://localhost:${this.portFromBaseUrl()}${path}`, init);
    if (res.ok) return res.json();
    let body: any = {};
    try { body = await res.clone().json(); } catch {}
    const msg = body?.error ?? `request failed (${res.status})`;
    throw new Error(`[deepPairing] ${msg}`);
  }

  /** List past sessions for this project. Uses the daemon's public /api/sessions. */
  async listPastSessions(): Promise<Array<{
    id: string;
    createdAt: string;
    lastActivity: string;
    summary: string;
    artifactCount: number;
    hasDecisions: boolean;
  }>> {
    const data = await this.requestPublic<{ sessions: any[] }>("/api/sessions");
    return data.sessions ?? [];
  }

  /** Load a specific past session's full state. */
  async loadPastSession(sessionId: string): Promise<any> {
    return this.requestPublic<any>(`/api/sessions/${encodeURIComponent(sessionId)}`);
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
    const data = await this.requestPublic<{ results: any[] }>(`/api/search?${params}`);
    return data.results ?? [];
  }

  /**
   * BB4 — agent-facing moat surface. Mirrors FileStore.getLedgerDigest by
   * fetching the same /api/ledger/digest endpoint the YourTaste drawer
   * uses, so a wrapper-mode agent can ask "what stances has this user
   * accumulated cross-project?" without spinning up its own FileStore.
   */
  async getLedgerDigest(): Promise<{
    shapedThisProject: number;
    nearMissesThisProject: number;
    blockedThisProject: number;
    sessionsTouched: number;
    topCitedStances: Array<{
      concept: string;
      source: "session" | "team";
      citationCount: number;
      // FF4 — passed through from the daemon's EE3 augmentation.
      globalCitationCount?: number;
      sampleArtifactId?: string;
      sampleSessionId?: string;
    }>;
    globalLedger: { concepts: number; projects: number; multiProjectConcepts: number };
  }> {
    return this.requestPublic("/api/ledger/digest");
  }

  private portFromBaseUrl(): number {
    // baseUrl = http://localhost:{port}/api/internal/sessions/{sessionId}
    const match = this.baseUrl.match(/localhost:(\d+)/);
    return match ? parseInt(match[1], 10) : 3847;
  }
}
