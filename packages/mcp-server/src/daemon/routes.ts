/**
 * Internal API routes for daemon ↔ MCP wrapper communication.
 * These are called by DaemonClient, not by the web UI.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { FileStore } from "../store/file-store.js";
import { ERROR_CODES } from "../error-codes.js";
import type { PreflightTrace } from "@deeppairing/shared";
import { AutonomyLevelSchema, DetailDensitySchema } from "@deeppairing/shared";
import { recordMetricEvent } from "../store/metrics-store.js";
import { projectHashGate } from "../http/guards.js";

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

// S2 — parity: the internal mutating routes (createArtifact / addComment /
// recordDecisionRequest) used to forward `await c.req.json()` straight to the
// store with no validation, so a malformed body (non-string title, etc.) hit a
// `.trim()` and 500'd instead of a clean 400. Bearer-gated and no injection
// sink (the store builds objects field-by-field), so this is robustness, not a
// live vuln — but it brings them up to the same tier as the memory routes.
// `.passthrough()` keeps every optional field the store reads (parentId,
// version, target, intent, …) untouched.
// #162 — a `secretWarnings` key in a create-artifact body still passes
// through here (older wrappers send it) but is IGNORED: FileStore.
// createArtifact scans `content` authoritatively and recomputes, so a
// bearer-authed caller can neither suppress nor forge warnings.
const CreateArtifactBody = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    title: z.string().min(1),
    content: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const AddCommentBody = z
  .object({
    id: z.string().min(1),
    artifactId: z.string().min(1),
    content: z.string(),
    author: z.enum(["human", "agent"]),
  })
  .passthrough();
const RecordDecisionBody = z.record(z.string(), z.unknown()); // must be an object; shape is the store's concern
// Preference-setter bodies — validated against the SHARED enum schemas so the
// internal route rejects a poison value the same way /api/preferences does.
const AutonomyPostBody = z.object({ level: AutonomyLevelSchema });
const DetailDensityPostBody = z.object({ density: DetailDensitySchema });

async function parseJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  try {
    return { ok: true, data: schema.parse(await c.req.json()) };
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid body" : "invalid JSON";
    return { ok: false, res: c.json({ error: message, code: ERROR_CODES.validation_error }, 400) };
  }
}

// H2-2 (#145) — guard ONLY the JSON parse for the internal routes that
// destructure a bare `await c.req.json()`. A non-JSON / null / array / scalar
// body used to throw (or throw on the subsequent destructure of null / silently
// proceed on a scalar) → an uncaught 500 or a wrong 200; return a clean 400
// instead. This does NOT own field-level validation — each route keeps its own
// downstream checks (FN5 optionId, D10 updates array, …) which still run on a
// successfully-parsed object and still produce their specific messages. Bearer
// auth is enforced by upstream middleware, so this never runs before the gate.
//
// `opts.allowEmpty` (H2-2 review) is for the ONE route (/register) that
// legitimately accepts an EMPTY body — "" ⇒ {} ⇒ 200. A body of literal
// `null` / `42` / `[]` is NOT empty and is still a 400. Reads via c.req.text()
// so empty is distinguishable from malformed (c.req.json() throws on both).
//
// SECURITY / contract note (Fix C): this does NOT strip a `__proto__` own
// property from the parsed object. That is safe TODAY only because every caller
// destructures NAMED fields and never `...spread`s the body nor uses its keys
// as map keys. A future route that spreads the body, or keys a map by it, must
// sanitize itself (see the `Object.create(null)` pattern in global-store.read)
// — do NOT assume this helper made the parsed body prototype-safe.
async function readJsonObject(
  c: Context,
  opts?: { allowEmpty?: boolean },
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  const invalidJson = () =>
    ({ ok: false as const, res: c.json({ error: "invalid JSON", code: ERROR_CODES.validation_error }, 400) });
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return invalidJson();
  }
  if (opts?.allowEmpty && raw.trim() === "") {
    return { ok: true, body: {} };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalidJson();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      res: c.json({ error: "expected a JSON object body", code: ERROR_CODES.validation_error }, 400),
    };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

type SessionMap = Map<string, FileStore>;
type BroadcastFn = (sessionId: string, event: any) => void;
type LogFn = (msg: string) => void;

/**
 * Y3' — sentinel returned by `requireStore()` when the session isn't
 * registered. The caller pattern is `const r = requireStore(c, sid); if
 * (!r.ok) return r.response;` — same shape across every route. 404 with
 * a structured code field (ERROR_CODES.session_not_registered) so DaemonClient (or any
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

/**
 * S1 — the two root-app session READS (the multi-session companion UI uses
 * these to merge artifacts across sessions). Factored out of daemon.ts so the
 * X-Project-Hash gate is wired together with the handlers in ONE testable unit:
 * previously they lived as bare app.use/app.get on daemon.ts's import-time app,
 * untestable, so a reorder/typo could silently un-gate the full-state read.
 * /api/live-session returns getFullState() — every artifact, comment, decision —
 * so a stale tab on a daemon serving a DIFFERENT project must not read it.
 */
export function createActiveSessionRoutes(
  sessions: SessionMap,
  sessionMeta: Map<string, SessionMeta>,
  daemonHash: string | undefined,
  /** D8 (M8) — registered-wrapper set for the honest `live` flag. Optional so
   *  route-logic fixtures don't thread it (undefined ⇒ every session reports live). */
  activeSessions?: Set<string>,
): Hono {
  const app = new Hono();
  const gate = projectHashGate(daemonHash);
  app.use("/api/active-sessions", gate);
  app.use("/api/live-session/*", gate);

  app.get("/api/active-sessions", (c) => {
    const list = Array.from(sessions.entries()).map(([id, store]) => {
      const meta = sessionMeta.get(id);
      return {
        sessionId: id,
        title: meta?.title ?? id,
        project: meta?.project ?? "",
        artifactCount: store.getArtifacts().length,
        // D8 (M8) — honest liveness. The data map deliberately retains
        // unregistered sessions (readable history); the UI needs to know
        // which still have a REGISTERED wrapper so dead sessions stop
        // wearing a live green dot forever. Fixtures without the set report
        // live (matches old-daemon behavior the client also tolerates).
        live: activeSessions ? activeSessions.has(id) : true,
      };
    });
    return c.json({ sessions: list });
  });

  // A6a — serve a single live session's state directly from the in-memory store
  // so the companion UI's MultiAgentSync can merge artifacts across sessions.
  app.get("/api/live-session/:sessionId", (c) => {
    const store = sessions.get(c.req.param("sessionId"));
    if (!store) return c.json({ error: "unknown_session" }, 404);
    return c.json(store.getFullState());
  });

  return app;
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
  /**
   * C-3 — the set of sessions with a LIVE registered wrapper, distinct from
   * the `sessions` data map (which deliberately retains a session's store
   * after unregister so the companion UI can keep reading it). /register adds,
   * /unregister removes. The daemon's idle-shutdown keys on this set + the UI
   * client count — NOT on `sessions.size`, which is monotonic and so kept the
   * daemon alive forever (one leaked node process per project ever opened).
   * Optional so route-logic test fixtures don't have to thread it.
   */
  activeSessions?: Set<string>,
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
            code: ERROR_CODES.daemon_auth_required,
          },
          401,
        );
      }
      await next();
    });
  }

  // B2 — agent-activity heartbeat. Every internal request IS the agent's
  // wrapper doing something (check_feedback polls, artifact writes, comment
  // acks), so it's the honest liveness signal the TurnIndicator was previously
  // guessing at from artifact timestamps (which go quiet during a long edit
  // run). Broadcast a throttled `agent_activity` per session; the UI shows
  // "Agent working · Nm" from it. Runs AFTER the bearer gate above (Hono
  // middleware order) and skips failed requests so unauthenticated probes
  // can't light the indicator.
  const lastActivityBroadcastAt = new Map<string, number>();
  const AGENT_ACTIVITY_THROTTLE_MS = 5_000;
  app.use("/api/internal/sessions/*", async (c, next) => {
    await next();
    if (c.res.status >= 400) return;
    const m = c.req.path.match(/^\/api\/internal\/sessions\/([a-zA-Z0-9_-]+)(\/|$)/);
    const sid = m?.[1];
    if (!sid) return;
    const now = Date.now();
    if (now - (lastActivityBroadcastAt.get(sid) ?? 0) < AGENT_ACTIVITY_THROTTLE_MS) return;
    lastActivityBroadcastAt.set(sid, now);
    broadcast(sid, { type: "agent_activity", at: new Date(now).toISOString() });
  });

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
            code: ERROR_CODES.session_not_registered,
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
    // H2-2 review — /register is the one route that legitimately accepts an
    // empty body (wrapper may POST nothing) → {}. But a literal `null`/`42`
    // parsed successfully and then `body.expectedProjectRoot` threw a
    // TypeError (500) or a scalar body silently 200'd. allowEmpty keeps ""⇒{}
    // while rejecting non-object bodies.
    const parsedReg = await readJsonObject(c, { allowEmpty: true });
    if (!parsedReg.ok) return parsedReg.res;
    const body = parsedReg.body as { expectedProjectRoot?: string; title?: string; project?: string };
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
          code: ERROR_CODES.project_mismatch,
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
    // C-3 — mark this session's wrapper as live so idle-shutdown holds off.
    activeSessions?.add(sessionId);
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
    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.res;
    const { title } = parsed.body as { title: string };
    const meta = sessionMeta.get(sessionId);
    if (meta) meta.title = title;
    broadcast(sessionId, { type: "session_renamed", sessionId, title });
    return c.json({ status: "renamed" });
  });

  app.post("/api/internal/sessions/:sessionId/unregister", async (c) => {
    const sessionId = c.req.param("sessionId");
    const store = sessions.get(sessionId);
    if (store) store.forceFlush();
    // Don't delete from the data map — the session's store stays so the web UI
    // can keep reading it. But DO drop it from the active set: with the wrapper
    // gone, the daemon may idle-shut once the UI client also disconnects.
    activeSessions?.delete(sessionId);
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
    const parsed = await parseJsonBody(c, CreateArtifactBody);
    if (!parsed.ok) return parsed.res;
    const artifact = r.store.createArtifact(parsed.data as Parameters<typeof r.store.createArtifact>[0]);
    broadcast(sessionId, { type: "artifact_created", artifact });
    return c.json({ artifact });
  });

  app.get("/api/internal/sessions/:sessionId/artifacts", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ artifacts: r.store.getArtifacts() });
  });

  // V-fix — HUMAN-driven status-change drain (mirrors comments/unacknowledged
  // + comments/acknowledge). check_feedback reads these once then acks so the
  // agent gets an observable per-artifact "art_X is now approved" signal.
  app.get("/api/internal/sessions/:sessionId/artifacts/status-changes", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ artifacts: r.store.getUnacknowledgedStatusChanges() });
  });

  app.post("/api/internal/sessions/:sessionId/artifacts/status-changes/acknowledge", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    // NIT — a non-JSON/null body used to make c.req.json() throw → 500. Return
    // a clean 400 instead.
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Expected a JSON body with { ids: string[] }", code: ERROR_CODES.validation_error }, 400);
    }
    const { ids } = body as { ids?: unknown };
    r.store.acknowledgeStatusChanges(Array.isArray(ids) ? ids : []);
    return c.json({ status: "acknowledged" });
  });

  app.post("/api/internal/sessions/:sessionId/artifacts/:artifactId/status", async (c) => {
    const sessionId = c.req.param("sessionId");
    const artifactId = c.req.param("artifactId");
    const r = requireStore(c, sessionId);
    if (!r.ok) return r.response;
    const bodyR = await readJsonObject(c);
    if (!bodyR.ok) return bodyR.res;
    const { status, reason } = bodyR.body as {
      status: Parameters<typeof r.store.updateArtifactStatus>[1];
      reason?: Parameters<typeof r.store.updateArtifactStatus>[2];
    };
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

  // D10 (H2) — agent marks plan step execution; UI renders the live strip.
  app.post("/api/internal/sessions/:sessionId/artifacts/:artifactId/plan-progress", async (c) => {
    const sessionId = c.req.param("sessionId");
    const artifactId = c.req.param("artifactId");
    const r = requireStore(c, sessionId);
    if (!r.ok) return r.response;
    const bodyR = await readJsonObject(c);
    if (!bodyR.ok) return bodyR.res;
    const { updates } = bodyR.body as { updates?: unknown };
    if (!Array.isArray(updates)) return c.json({ error: "updates must be an array" }, 400);
    // D10 review — mirror the handler's validation (junk statuses would
    // persist, then silently vanish on the next restart when coercePlanStep
    // drops them). Bearer-authed callers only, but symmetry keeps it honest.
    const VALID = new Set(["pending", "in_progress", "done", "skipped"]);
    const clean = updates.filter(
      (u: any) => Number.isInteger(u?.stepIndex) && u.stepIndex >= 0 && VALID.has(u?.status),
    );
    const artifact = r.store.updatePlanProgress(artifactId, clean);
    // D10 review — not-found is a DOMAIN result, not a transport error:
    // DaemonClient.request throws on non-2xx, so a 404 here surfaced as an
    // opaque throw instead of the handler's crafted isError message (and the
    // client's null path was dead code). 200 + null, like :456's comment read.
    if (!artifact) return c.json({ artifact: null });
    // PF1 (verified): forceFlush here was 216ms of SYNC disk I/O per step
    // update ON THE HOT PATH — the broadcast below reads memory, nothing
    // downstream reads disk (unlike the status route, whose Stop hook DOES),
    // and updatePlanProgress already scheduleFlush'd. Progress is
    // reconstructible; the debounced flush is plenty.
    // Carries the FULL artifact: step statuses live in content, and the web
    // store patches content in place (artifact_updated only patches status).
    broadcast(sessionId, { type: "plan_progress_updated", artifact });
    return c.json({ artifact });
  });

  app.post("/api/internal/sessions/:sessionId/artifacts/:artifactId/rename", async (c) => {
    const sessionId = c.req.param("sessionId");
    const r = requireStore(c, sessionId);
    if (!r.ok) return r.response;
    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.res;
    const { title } = parsed.body as { title: string };
    r.store.renameArtifact(c.req.param("artifactId"), title);
    broadcast(sessionId, { type: "artifact_renamed", artifactId: c.req.param("artifactId"), title });
    return c.json({ status: "renamed" });
  });

  // --- Comments ---

  app.post("/api/internal/sessions/:sessionId/comments", async (c) => {
    const sessionId = c.req.param("sessionId");
    const r = requireStore(c, sessionId);
    if (!r.ok) return r.response;
    const parsed = await parseJsonBody(c, AddCommentBody);
    if (!parsed.ok) return parsed.res;
    const params = parsed.data as Parameters<typeof r.store.addComment>[0];
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
    // NIT — clean 400 on a malformed/null body instead of a 500 from json().
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Expected a JSON body with { ids: string[] }", code: ERROR_CODES.validation_error }, 400);
    }
    const { ids } = body as { ids?: unknown };
    r.store.acknowledgeComments(Array.isArray(ids) ? ids : []);
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
    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.res;
    const { answerCommentId } = parsed.body as { answerCommentId: string };
    r.store.markCommentAnswered(c.req.param("commentId"), answerCommentId);
    // F1 — record the metric HERE (daemon-side), the truth point for an
    // answered question. The MCP server's question_answered broadcast is a
    // no-op in standalone, so the prior daemon broadcast-tap never saw it.
    if (daemonProjectRoot) {
      try { recordMetricEvent(daemonProjectRoot, { kind: "question_answered" }); } catch {}
    }
    return c.json({ status: "marked" });
  });

  // F1 — sink for metric events the MCP server knows about but the daemon's
  // broadcast-tap can't see (the wrapper's broadcast is a no-op in standalone).
  // Today: real pre-flight blocks (the demo's synthetic block is daemon-side and
  // intentionally NOT counted). Whitelisted by kind so it can't be abused to
  // forge arbitrary counters.
  app.post("/api/internal/sessions/:sessionId/metrics", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const body = await c.req.json().catch(() => null);
    if (daemonProjectRoot && body?.kind === "preflight_block") {
      try {
        recordMetricEvent(daemonProjectRoot, {
          kind: "preflight_block",
          source: body.source === "team" ? "team" : "session",
        });
      } catch {}
    }
    // Phase-1 (D) — admitted near-misses, routed here from the MCP-server
    // process (whose broadcast is a no-op in standalone). Whitelisted by kind
    // so the sink can't be abused to forge arbitrary counters.
    if (daemonProjectRoot && body?.kind === "preflight_near_miss") {
      try {
        recordMetricEvent(daemonProjectRoot, {
          kind: "preflight_near_miss",
          source: body.source === "team" ? "team" : "session",
        });
      } catch {}
    }
    return c.json({ ok: true });
  });

  app.post("/api/internal/sessions/:sessionId/comments/:commentId/mark-resolved", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    // H2-2 review — was `.catch(() => ({}))`: a literal `null` body parsed OK
    // then `const { resolvedAt } = null` threw a TypeError → 500. The real
    // client always sends an object (`{resolvedAt}`), so no empty-body affordance.
    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.res;
    const { resolvedAt } = parsed.body as { resolvedAt?: string };
    r.store.markCommentHumanResolved(c.req.param("commentId"), resolvedAt);
    return c.json({ status: "resolved" });
  });

  // --- Decisions ---

  app.post("/api/internal/sessions/:sessionId/decisions", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const parsed = await parseJsonBody(c, RecordDecisionBody);
    if (!parsed.ok) return parsed.res;
    // The wire body is deliberately loose (RecordDecisionBody = z.record;
    // present_options' upstream validator owns the real shape check) — the
    // C6c-typed param surface makes that laundering explicit.
    r.store.recordDecisionRequest(parsed.data as unknown as Parameters<typeof r.store.recordDecisionRequest>[0]);
    return c.json({ status: "recorded" });
  });

  app.post("/api/internal/sessions/:sessionId/decisions/:decisionId/resolve", async (c) => {
    const sessionId = c.req.param("sessionId");
    const r = requireStore(c, sessionId);
    if (!r.ok) return r.response;
    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.res;
    const { optionId, reasoning, confidence, predictedOutcome } = parsed.body as {
      optionId?: unknown;
      reasoning?: string;
      confidence?: "low" | "medium" | "high";
      predictedOutcome?: string;
    };
    const decisionId = c.req.param("decisionId");
    // FN5 — require a non-empty optionId. Without this, a missing optionId
    // no-ops resolveDecision but the F2 guard (undefined !== undefined → false)
    // skipped its 400, so the route returned 200 "resolved" + broadcast
    // optionId:undefined while nothing was resolved.
    if (typeof optionId !== "string" || optionId.length === 0) {
      return c.json({ error: "optionId is required", code: ERROR_CODES.validation_error }, 400);
    }
    const prediction = confidence || predictedOutcome ? { confidence, predictedOutcome } : undefined;
    r.store.resolveDecision(decisionId, optionId, reasoning, prediction);
    // F2 — honor resolveDecision's fail-closed rejection of an unknown optionId
    // (only when the decision RECORD exists; a missing record is a no-op here).
    if (r.store.getDecision(decisionId) && r.store.getDecisionResponse(decisionId)?.optionId !== optionId) {
      return c.json({ error: `optionId "${optionId}" is not an option of decision ${decisionId}`, code: ERROR_CODES.validation_error }, 400);
    }
    broadcast(sessionId, { type: "decision_resolved", decisionId, optionId, reasoning, confidence, predictedOutcome });
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
    // NIT — clean 400 on a malformed/null body instead of a 500 from json().
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Expected a JSON body with { ids: string[] }", code: ERROR_CODES.validation_error }, 400);
    }
    const { ids } = body as { ids?: unknown };
    r.store.acknowledgeDecisions(Array.isArray(ids) ? ids : []);
    // C2 — this is the exact moment the agent CONSUMES the human's decision
    // (check_feedback drains resolved decisions then acks them). Broadcast it
    // so the resolved DecisionCard can show a receipt ("Claude picked this
    // up") instead of leaving the handoff unconfirmed. Only ids that matched
    // a real decision record — a buggy wrapper acking unknown ids must not
    // fabricate receipts client-side.
    const known = (Array.isArray(ids) ? ids : []).filter((id: string) => r.store.getDecision(id));
    if (known.length > 0) {
      broadcast(c.req.param("sessionId"), { type: "decisions_acknowledged", decisionIds: known });
    }
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
    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.res;
    const { artifactId } = parsed.body as { artifactId: string };
    r.store.recordPlanReview(artifactId);
    return c.json({ status: "recorded" });
  });

  app.post("/api/internal/sessions/:sessionId/plan-reviews/:artifactId/resolve", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.res;
    const { verdict, feedback } = parsed.body as {
      verdict: Parameters<typeof r.store.resolvePlanReview>[1];
      feedback?: string;
    };
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
      return c.json({ error: message, code: ERROR_CODES.validation_error }, 400);
    }
    r.store.recordRejectedApproach(parsed);
    // FN3 — record the metric HERE (daemon-side truth point). Decision-resolution
    // ledger writes come through this route via DaemonClient; the MCP wrapper's
    // broadcast is a no-op, so the broadcast-tap never saw them (ledgerWrites
    // sat ~0 in prod). Mirrors the /metrics + /answered F1 pattern. Exclude
    // demo sessions, matching the broadcast tap's demo guard.
    if (daemonProjectRoot && !c.req.param("sessionId").startsWith("demo_")) {
      try { recordMetricEvent(daemonProjectRoot, { kind: "ledger_write", verdict: "rejected" }); } catch {}
    }
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
      return c.json({ error: message, code: ERROR_CODES.validation_error }, 400);
    }
    r.store.recordApprovedPattern(parsed);
    if (daemonProjectRoot && !c.req.param("sessionId").startsWith("demo_")) {
      try { recordMetricEvent(daemonProjectRoot, { kind: "ledger_write", verdict: "approved" }); } catch {}
    }
    return c.json({ status: "recorded" });
  });

  // Scope-down a personal rejected-approach the pre-flight gate matched as a
  // false positive (mirror of recordRejectedApproach in reverse). Exists for
  // IStore symmetry; the human-facing path is the public /api/philosophy/override.
  app.post("/api/internal/sessions/:sessionId/memory/override", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const body = await c.req.json().catch(() => ({}));
    const result = await r.store.overrideRejectedApproach({
      description: typeof body?.description === "string" ? body.description : undefined,
      concept: typeof body?.concept === "string" ? body.concept : undefined,
    });
    return c.json({ status: "overridden", ...result });
  });

  // III8 — per-project opt-in to publish to the global ledger. The wrapper
  // (or a future UI surface) calls these to flip the gate that controls
  // whether recordRejectedApproach / recordApprovedPattern mirror into
  // ~/.deeppairing/philosophy/v1.json. Default is off (opt-in).
  app.post("/api/internal/sessions/:sessionId/memory/global-publish", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const body = await c.req.json().catch(() => ({}));
    const enabled = body?.enabled === true;
    r.store.setGlobalLedgerPublish?.(enabled);
    return c.json({ status: "set", enabled });
  });

  app.get("/api/internal/sessions/:sessionId/memory/global-publish", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    const enabled = r.store.getGlobalLedgerPublish?.() ?? false;
    return c.json({ enabled });
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
    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.res;
    const { trace } = parsed.body as { trace: PreflightTrace };
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
    // MUST validate the enum (not just "is an object"): this dial arms the
    // auto-approve countdown, so a garbage value reaching the store fails OPEN
    // toward LESS supervision. Zod-parse against the SAME schema
    // /api/preferences uses → clean 400, nothing written.
    const parsed = await parseJsonBody(c, AutonomyPostBody);
    if (!parsed.ok) return parsed.res;
    r.store.setAutonomyLevel(parsed.data.level);
    return c.json({ status: "updated" });
  });

  // --- Detail density (#139) — verbosity of artifact prose ---

  app.get("/api/internal/sessions/:sessionId/detail-density", (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    return c.json({ density: r.store.getDetailDensity() });
  });

  app.post("/api/internal/sessions/:sessionId/detail-density", async (c) => {
    const r = requireStore(c, c.req.param("sessionId"));
    if (!r.ok) return r.response;
    // Validate the enum against the shared schema (single source of truth) →
    // 400 on an invalid value, nothing written.
    const parsed = await parseJsonBody(c, DetailDensityPostBody);
    if (!parsed.ok) return parsed.res;
    r.store.setDetailDensity(parsed.data.density);
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
