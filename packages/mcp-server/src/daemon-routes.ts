/**
 * Internal API routes for daemon ↔ MCP wrapper communication.
 * These are called by DaemonClient, not by the web UI.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { FileStore } from "./store/file-store.js";
import type { Artifact, Comment } from "@deeppairing/shared";

// BB8 — wire-input validation for the typed-object signatures AA1
// introduced. AA1's typing protected only in-process callers; routes
// that pass req.body straight through still crashed with TypeError if
// `description` came in as undefined or non-string. A 500 isn't the
// right shape — these are validation errors. Zod gives us a clean 400
// with a structured code the wrapper can act on, plus first-line
// safety against malformed JSON shapes. Mirrors the validation tier
// the public `/api/philosophy/seed` route already does inline.
const RecordRejectedBody = z.object({
  description: z.string().min(1),
  reason: z.string().optional(),
  sourceArtifactId: z.string().optional(),
  concept: z.string().optional(),
});
const RecordApprovedBody = z.object({
  description: z.string().min(1),
  concept: z.string().optional(),
});

type SessionMap = Map<string, FileStore>;
type BroadcastFn = (sessionId: string, event: any) => void;
type LogFn = (msg: string) => void;

/**
 * Y3' — sentinel returned by `requireStore()` when the session isn't
 * registered. The caller pattern is `const r = requireStore(c, sid); if
 * (!r.ok) return r.response;` — same shape across every route. 404 with
 * a structured `code: "session_not_registered"` so DaemonClient (or any
 * future caller) can act on it without parsing prose.
 *
 * Pre-Y3' the helper silently `createSession()`-d on miss, which reopened
 * the U0.6 orphan-session class through the internal seam: a wrapper that
 * died and respawned with a slightly different sessionId, or a stale
 * webview reconnect, would mint an empty FileStore and clobber the merge
 * baseline. Now the only legitimate creator is /register; everything else
 * 404s loud.
 */
type StoreLookup = { ok: true; store: FileStore } | { ok: false; response: Response };

export interface SessionMeta {
  title: string;
  project: string;
  registeredAt: string;
}

export function createDaemonRoutes(
  sessions: SessionMap,
  sessionMeta: Map<string, SessionMeta>,
  createSession: (sessionId: string) => FileStore,
  broadcast: BroadcastFn,
  logFn?: LogFn,
  /**
   * Y3' — daemon's projectRoot (the directory it was spawned for). When a
   * wrapper registers with `expectedProjectRoot` set, /register refuses
   * with 403 if it doesn't match. Defends against the port-adoption foot-
   * gun: wrapper for project A connects to daemon serving project B
   * (because daemon-A failed to spawn / port collision) and silently
   * writes A's artifacts into B's store.
   */
  daemonProjectRoot?: string,
  /**
   * II1 — shared-secret token required on every `/api/internal/*` route.
   * Pre-II1 the internal routes were completely unauthenticated. A malicious
   * npm package run by the user's normal dev workflow could curl localhost
   * and `POST /api/internal/sessions/{id}/register` then inject fake
   * "human-approved" artifacts or poison the rejection memory. The
   * X-Project-Hash gate fired on public routes only; internal was wide open.
   *
   * Daemon generates this on startup (`crypto.randomBytes(32).hex`), writes
   * it into `.deeppairing/daemon.json` with mode 0600, and only the same
   * uid can read it. Wrappers (DaemonClient) read it from the same file and
   * send it as `Authorization: Bearer <token>`. Other local processes
   * without read access to daemon.json get a 401 — closing the entire
   * local-process-as-attacker class without adding any UX friction.
   *
   * Optional so test fixtures that don't care about auth (which is most of
   * them — the auth concern is at the daemon boundary, not the route logic)
   * skip the check by passing undefined.
   */
  authToken?: string,
) {
  // U0.6 — same diagnostic seam as routes.ts. Wrapper-side mutations log
  // here; we want both UI clicks and agent-driven status updates in one log.
  const log: LogFn = logFn ?? (() => {});
  const app = new Hono();

  // II1 — auth gate. Runs before any handler. When the route construction
  // didn't supply an authToken (test fixtures), the gate is a no-op so the
  // existing route tests don't have to thread the token.
  if (authToken) {
    app.use("/api/internal/*", async (c, next) => {
      const auth = c.req.header("Authorization");
      const expected = `Bearer ${authToken}`;
      if (auth !== expected) {
        log(`[internal-auth] 401 — bad/missing Authorization header path=${c.req.path}`);
        return c.json(
          {
            error: "Missing or invalid Authorization header. Internal routes require the daemon's shared secret.",
            code: "daemon_auth_required",
          },
          401,
        );
      }
      await next();
    });
  }

  /**
   * Y3' — lookup helper. Returns the store or a 404 response. Only
   * /register may call createSession; every other route uses this.
   */
  function requireStore(c: Context, sessionId: string): StoreLookup {
    const store = sessions.get(sessionId);
    if (!store) {
      log(`[internal] 404 — session not registered: sid=${sessionId} path=${c.req.path}`);
      return {
        ok: false,
        response: c.json(
          {
            error: `Session ${sessionId} is not registered. The wrapper must POST /api/internal/sessions/:sessionId/register before any other call.`,
            code: "session_not_registered",
          },
          404,
        ),
      };
    }
    return { ok: true, store };
  }

  // --- Session lifecycle ---

  app.post("/api/internal/sessions/:sessionId/register", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json().catch(() => ({}));
    // Y3' — project binding handshake. When the wrapper provides
    // `expectedProjectRoot`, refuse if it doesn't match the daemon's own
    // root. Both response and the 403 echo `projectRoot` so the wrapper
    // can sanity-check what daemon it's actually talking to.
    if (
      typeof body.expectedProjectRoot === "string" &&
      daemonProjectRoot &&
      body.expectedProjectRoot !== daemonProjectRoot
    ) {
      log(
        `[register] 403 — project mismatch: sid=${sessionId} ` +
        `wrapper.expected=${body.expectedProjectRoot} daemon.actual=${daemonProjectRoot}`,
      );
      return c.json(
        {
          error: `Daemon serves ${daemonProjectRoot}, not ${body.expectedProjectRoot}. The wrapper likely adopted the wrong daemon (port collision); restart it.`,
          code: "project_mismatch",
          projectRoot: daemonProjectRoot,
        },
        403,
      );
    }
    // /register is the ONLY legitimate session creator. Either adopt an
    // already-registered store (re-register from a re-spawned wrapper is
    // fine) or mint a new one explicitly here.
    let store = sessions.get(sessionId);
    if (!store) {
      store = createSession(sessionId);
      sessions.set(sessionId, store);
    }
    sessionMeta.set(sessionId, {
      title: body.title ?? sessionId,
      project: body.project ?? "",
      registeredAt: new Date().toISOString(),
    });
    return c.json({
      status: "registered",
      sessionId,
      projectRoot: daemonProjectRoot,
      state: store.getFullState(),
    });
  });

  // Rename a session
  app.post("/api/internal/sessions/:sessionId/rename", async (c) => {
    const sessionId = c.req.param("sessionId");
    const { title } = await c.req.json();
    const meta = sessionMeta.get(sessionId);
    if (meta) meta.title = title;
    broadcast(sessionId, { type: "session_renamed", sessionId, title });
    return c.json({ status: "renamed" });
  });

  app.post("/api/internal/sessions/:sessionId/unregister", async (c) => {
    const sessionId = c.req.param("sessionId");
    const store = sessions.get(sessionId);
    if (store) store.forceFlush();
    // Don't delete from map — session data persists for the web UI
    return c.json({ status: "unregistered" });
  });

  // AA2 — DaemonClient hits this after auto-recovering from a 404
  // session_not_registered. Wrapper-side recovery is invisible to the
  // browser otherwise — the WS keeps streaming on the same socket so the
  // companion UI never knows its optimistic state may be stale. Broadcasting
  // `daemon_resumed` lets the connected clients refetch full state.
  app.post("/api/internal/sessions/:sessionId/recovered", async (c) => {
    const sessionId = c.req.param("sessionId");
    log(`[recovered] sid=${sessionId} — wrapper auto-re-registered after a 404`);
    broadcast(sessionId, { type: "daemon_resumed", sessionId });
    return c.json({ status: "broadcast" });
  });

  // --- Artifacts ---

  app.post("/api/internal/sessions/:sessionId/artifacts", async (c) => {
    const sessionId = c.req.param("sessionId");
    const r = requireStore(c, sessionId);
    if (!r.ok) return r.response;
    const params = await c.req.json();
    const artifact = r.store.createArtifact(params);
    broadcast(sessionId, { type: "artifact_created", artifact });
    return c.json({ artifact });
  });

  app.get("/api/internal/sessions/:sessionId/artifacts", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ artifacts: r.store.getArtifacts() });
  });

  app.post("/api/internal/sessions/:sessionId/artifacts/:artifactId/status", async (c) => {
    const sessionId = c.req.param("sessionId");
    const artifactId = c.req.param("artifactId");
    const r = requireStore(c, sessionId);
    if (!r.ok) return r.response;
    const { status, reason } = await c.req.json();
    const target = r.store.getArtifacts().find((a) => a.id === artifactId);
    log(
      `[status:internal] sid=${sessionId} artifactId=${artifactId} ` +
      `targetFound=${!!target} fromStatus=${target?.status ?? "(missing)"} ` +
      `toStatus=${status} reason=${reason ?? "unspecified"}`,
    );
    r.store.updateArtifactStatus(artifactId, status, reason);
    r.store.forceFlush();
    broadcast(sessionId, { type: "artifact_updated", artifactId, status, reason: reason ?? "unspecified" });
    return c.json({ status: "updated" });
  });

  app.post("/api/internal/sessions/:sessionId/artifacts/:artifactId/rename", async (c) => {
    const sessionId = c.req.param("sessionId");
    const r = requireStore(c, sessionId);
    if (!r.ok) return r.response;
    const { title } = await c.req.json();
    r.store.renameArtifact(c.req.param("artifactId"), title);
    broadcast(sessionId, { type: "artifact_renamed", artifactId: c.req.param("artifactId"), title });
    return c.json({ status: "renamed" });
  });

  // --- Comments ---

  app.post("/api/internal/sessions/:sessionId/comments", async (c) => {
    const sessionId = c.req.param("sessionId");
    const r = requireStore(c, sessionId);
    if (!r.ok) return r.response;
    const params = await c.req.json();
    // params already has intent/parentCommentId when the MCP wrapper sends them
    const requestedId = params.id;
    const comment = r.store.addComment(params);
    // U0.1 — only broadcast when addComment created a new record. Dedupe
    // returns the existing comment whose id differs from the one we asked
    // for; the original already broadcast.
    if (comment.id === requestedId) {
      broadcast(sessionId, { type: "comment_added", comment });
    }
    return c.json({ comment });
  });

  app.get("/api/internal/sessions/:sessionId/comments/unacknowledged", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ comments: r.store.getUnacknowledgedComments() });
  });

  app.post("/api/internal/sessions/:sessionId/comments/acknowledge", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const { ids } = await c.req.json();
    r.store.acknowledgeComments(ids);
    return c.json({ status: "acknowledged" });
  });

  app.get("/api/internal/sessions/:sessionId/artifacts/:artifactId/comments", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ comments: r.store.getCommentsForArtifact(c.req.param("artifactId")) });
  });

  app.get("/api/internal/sessions/:sessionId/comments/:commentId", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const comment = r.store.getComment(c.req.param("commentId"));
    return c.json({ comment: comment ?? null });
  });

  app.post("/api/internal/sessions/:sessionId/comments/:commentId/answered", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const { answerCommentId } = await c.req.json();
    r.store.markCommentAnswered(c.req.param("commentId"), answerCommentId);
    return c.json({ status: "marked" });
  });

  // --- Decisions ---

  app.post("/api/internal/sessions/:sessionId/decisions", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const params = await c.req.json();
    r.store.recordDecisionRequest(params);
    return c.json({ status: "recorded" });
  });

  app.post("/api/internal/sessions/:sessionId/decisions/:decisionId/resolve", async (c) => {
    const sessionId = c.req.param("sessionId");
    const r = requireStore(c, sessionId);
    if (!r.ok) return r.response;
    const { optionId, reasoning, confidence, predictedOutcome } = await c.req.json();
    const prediction = confidence || predictedOutcome ? { confidence, predictedOutcome } : undefined;
    r.store.resolveDecision(c.req.param("decisionId"), optionId, reasoning, prediction);
    broadcast(sessionId, { type: "decision_resolved", decisionId: c.req.param("decisionId"), optionId, reasoning, confidence, predictedOutcome });
    return c.json({ status: "resolved" });
  });

  app.get("/api/internal/sessions/:sessionId/decisions/pending", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ decisions: r.store.getPendingDecisions() });
  });

  app.get("/api/internal/sessions/:sessionId/decisions/resolved", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ decisions: r.store.getResolvedDecisions() });
  });

  app.post("/api/internal/sessions/:sessionId/decisions/acknowledge", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const { ids } = await c.req.json();
    r.store.acknowledgeDecisions(ids);
    return c.json({ status: "acknowledged" });
  });

  app.get("/api/internal/sessions/:sessionId/decisions/:decisionId", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ decision: r.store.getDecision(c.req.param("decisionId")) });
  });

  app.get("/api/internal/sessions/:sessionId/decisions/:decisionId/response", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ response: r.store.getDecisionResponse(c.req.param("decisionId")) });
  });

  // --- Plan Reviews ---

  app.post("/api/internal/sessions/:sessionId/plan-reviews", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const { artifactId } = await c.req.json();
    r.store.recordPlanReview(artifactId);
    return c.json({ status: "recorded" });
  });

  app.post("/api/internal/sessions/:sessionId/plan-reviews/:artifactId/resolve", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const { verdict, feedback } = await c.req.json();
    r.store.resolvePlanReview(c.req.param("artifactId"), verdict, feedback);
    return c.json({ status: "resolved" });
  });

  app.get("/api/internal/sessions/:sessionId/plan-reviews/pending", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ reviews: r.store.getPendingPlanReviews() });
  });

  app.get("/api/internal/sessions/:sessionId/plan-reviews/:artifactId/verdict", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json(r.store.getPlanReviewVerdict(c.req.param("artifactId")));
  });

  // --- Feedback long-poll ---

  app.get("/api/internal/sessions/:sessionId/wait-feedback", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const timeout = parseInt(c.req.query("timeout") ?? "30000", 10);
    await r.store.waitForFeedback(timeout);
    return c.json({ status: "complete" });
  });

  // --- State & metrics ---

  app.get("/api/internal/sessions/:sessionId/state", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json(r.store.getFullState());
  });

  app.get("/api/internal/sessions/:sessionId/metrics", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json(r.store.getEngagementMetrics());
  });

  app.post("/api/internal/sessions/:sessionId/flush", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    r.store.forceFlush();
    return c.json({ status: "flushed" });
  });

  // --- Memory ---

  app.get("/api/internal/sessions/:sessionId/memory", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json(r.store.getSessionMemory());
  });

  app.post("/api/internal/sessions/:sessionId/memory/rejected", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    // BB8 — Zod-validate the wire body. Pre-BB8, missing/non-string
    // `description` reached FileStore.recordRejectedApproach which did
    // `description.trim()` → TypeError → 500. The wrapper then saw an
    // opaque error instead of an actionable validation_error.
    let parsed: z.infer<typeof RecordRejectedBody>;
    try {
      parsed = RecordRejectedBody.parse(await c.req.json());
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid body" : "invalid JSON";
      return c.json({ error: message, code: "validation_error" }, 400);
    }
    r.store.recordRejectedApproach(parsed);
    return c.json({ status: "recorded" });
  });

  app.post("/api/internal/sessions/:sessionId/memory/approved", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    let parsed: z.infer<typeof RecordApprovedBody>;
    try {
      parsed = RecordApprovedBody.parse(await c.req.json());
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid body" : "invalid JSON";
      return c.json({ error: message, code: "validation_error" }, 400);
    }
    r.store.recordApprovedPattern(parsed);
    return c.json({ status: "recorded" });
  });

  // --- Preflight traces (Z1 — daemon-mode persistence for Y1') ---
  // Pre-Z1, persistPreflightTrace silently no-op'd when called against
  // DaemonClient because the method wasn't on the daemon's wire surface
  // — every standalone-wrapper user got the broadcast but never the
  // sidecar write, so a refresh lost the breadcrumb. These two routes
  // close the production-mode silent failure.

  app.post("/api/internal/sessions/:sessionId/preflight-traces/:artifactId", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const { trace } = await c.req.json();
    r.store.recordPreflightTrace?.(c.req.param("artifactId"), trace);
    return c.json({ status: "recorded" });
  });

  app.get("/api/internal/sessions/:sessionId/preflight-traces/:artifactId", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const trace = r.store.getPreflightTrace?.(c.req.param("artifactId")) ?? null;
    return c.json({ trace });
  });

  // --- Project context (guardrails + team preferences) ---

  app.get("/api/internal/sessions/:sessionId/guardrails", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    // AA7b — typed optional-chain replaces the (r.store as any) cast.
    // Side-bug noted in the deep dive: pre-AA7b the call was unawaited
    // on a MaybePromise return — guardrails could be a Promise that
    // serialized as `{}`. Now async + awaited.
    const guardrails = (await r.store.getProjectGuardrails?.()) ?? [];
    return c.json({ guardrails });
  });

  app.get("/api/internal/sessions/:sessionId/team-preferences", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const preferences = (await r.store.getTeamPreferences?.()) ?? [];
    return c.json({ preferences });
  });

  // --- Autonomy ---

  app.get("/api/internal/sessions/:sessionId/autonomy", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ level: r.store.getAutonomyLevel() });
  });

  app.post("/api/internal/sessions/:sessionId/autonomy", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const { level } = await c.req.json();
    r.store.setAutonomyLevel(level);
    return c.json({ status: "updated" });
  });

  // --- Active sessions list ---

  app.get("/api/internal/sessions", (c) => {
    const list = Array.from(sessions.entries()).map(([id, store]) => {
      const meta = sessionMeta.get(id);
      return {
        sessionId: id,
        title: meta?.title ?? id,
        project: meta?.project ?? "",
        artifactCount: store.getArtifacts().length,
        registeredAt: meta?.registeredAt,
      };
    });
    return c.json({ sessions: list });
  });

  return app;
}
