import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES } from "../error-codes.js";
import type { IStore } from "../store/store-interface.js";
import { FileStore } from "../store/file-store.js";
import { broadcast as defaultBroadcast } from "./websocket.js";
import { formatSessionMarkdown } from "../export/format-markdown.js";
import { getGlobalStore, isSeededEntry } from "../store/global-store.js";
import { projectHashOf } from "../project-root.js";
import { readMetrics, recordMetricEvent } from "../store/metrics-store.js";
import { maybeUpdateTaskStatus } from "../mcp/tasks-probe.js";
import { corsAllowedOrigin } from "./origin-policy.js";
import {
  CommentBodySchema,
  DecisionResolveBodySchema,
  StatusUpdateBodySchema,
  RenameBodySchema,
  PreferenceBodySchema,
  RetrospectiveBodySchema,
  formatZodIssues,
} from "@deeppairing/shared";

// U0.6 — getter may return null when no session matches AND none exist.
// Routes treat null as "no active session" rather than spawning a placeholder.
type StoreGetter = (sessionId?: string) => IStore | null;
type BroadcastFn = (event: any, sessionId?: string) => void;
type LogFn = (msg: string) => void;

/** V3 — DPContext is the typed Hono Context this module uses. No
 *  per-request Variables today, but the alias gives one place to add
 *  them in a future refactor without re-finding every call site. */
type DPContext = Context;

/**
 * H2-2 (#145) — parse a request body to a raw JSON value, distinguishing a
 * MALFORMED body from a valid one. The public app has a global
 * `app.onError(SyntaxError → 400)`, so an unguarded `c.req.json()` was already a
 * 400 — but `.catch(() => null)` then fed `null` into safeParse, which told a
 * client that POSTed literal garbage "expected object, received null" (a false
 * statement — they didn't send null). This returns a clean, honest generic 400
 * for unparseable input, while a body that GENUINELY is `null` parses through to
 * the caller's safeParse and still earns the accurate Zod "received null".
 * Reads via c.req.text() so empty/malformed are distinguishable from a real
 * `null`. Keeps the structured validation_error code shape (via ERROR_CODES).
 */
async function readJsonValue(
  c: DPContext,
): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  const invalid = () =>
    ({ ok: false as const, res: c.json({ error: "invalid JSON", code: ERROR_CODES.validation_error }, 400) });
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return invalid();
  }
  // Empty body is not valid JSON for these schema'd routes — treat as malformed.
  if (raw.trim() === "") return invalid();
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return invalid();
  }
}

/** Extract sessionId from X-Session-Id header */
function getSessionId(c: DPContext): string | undefined {
  return c.req.header("X-Session-Id") ?? undefined;
}

/**
 * AA4 + II2 — verify the browser's X-Project-Hash against the daemon's own
 * projectHash. Returns a 403 Response on mismatch or absence, `null` when
 * the request can proceed.
 *
 * Threat model: a stale browser tab whose sessionId came from
 * daemon-A's pre-shutdown state sends that sessionId to daemon-B (which
 * adopted port 3847 after A idle-shut). Pre-AA4 the daemon's
 * getDefaultStoreOrNull() fallback silently routed the mutation into
 * B's first arbitrary session — wrong-store write under wrong attribution.
 *
 * II2 — was back-compat-permissive: any request with no X-Project-Hash
 * fell through. Every shipped browser + the VSCode extension now send it
 * (HH1/HH4/HH5), so the back-compat path is now an attacker convenience:
 * a malicious local process can omit the header and hit the default
 * store. Flip to fail-closed.
 */
function checkProjectHash(c: DPContext, daemonHash: string | undefined): Response | null {
  if (!daemonHash) return null;
  const sentHash = c.req.header("X-Project-Hash");
  if (!sentHash || sentHash !== daemonHash) {
    return c.json(
      {
        // BB10 — message is fallback copy. The browser specializes the
        // toast on `code` and offers a one-click reload action.
        error: `Project hash mismatch — your tab is pointed at a daemon serving a different project. Reload the page to re-bind.`,
        code: ERROR_CODES.project_hash_mismatch,
        expected: daemonHash,
      },
      403,
    );
  }
  return null;
}

/** U0.6 — empty session state used when no MCP wrapper has registered yet.
 *  Lets the UI render a "waiting for Claude Code" surface without the daemon
 *  spawning a throwaway session just to hand back data. */
const EMPTY_STATE = {
  sessionId: null,
  status: "no_active_session",
  artifacts: [],
  comments: [],
  decisions: [],
  planReviews: [],
  autonomyLevel: "supervised",
  detailDensity: "rich",
  rejectedApproaches: [],
  approvedPatterns: [],
} as const;

export function createHttpRoutes(
  storeOrGetter: IStore | StoreGetter,
  projectRoot?: string,
  broadcastFn?: BroadcastFn,
  logFn?: LogFn,
  /**
   * III5 — daemon's shared secret (same value passed to createDaemonRoutes
   * via II1). When set, mutation-bearing public routes that the browser
   * UI calls (today: /api/prompts) require `Authorization: Bearer <token>`
   * in addition to the X-Project-Hash check. The browser receives this
   * token via the `window.__deepPairingToken` injection the daemon
   * performs on index.html serves.
   *
   * Why bother when same-uid curl can also obtain the token (by reading
   * daemon.json or by hitting GET / and scraping the injected script):
   * the auth raises the bar above "any same-uid process with read access
   * to .deeppairing/daemon.json" to "same-uid process with HTTP + sigh-
   * the-bearer overhead". More importantly it forces a sandboxed worker
   * (an npm subprocess with network but no filesystem) to additionally
   * curl the daemon's own HTML — which a defender can future-proof with
   * Origin/Referer checks, secure-cookie minting, or per-tab nonces.
   *
   * Optional so test fixtures that don't care about auth don't have to
   * thread the token; the route gate is a no-op when undefined.
   */
  authToken?: string,
) {
  const getStore: StoreGetter = typeof storeOrGetter === "function"
    ? storeOrGetter as StoreGetter
    : () => storeOrGetter;

  const broadcast: BroadcastFn = broadcastFn ?? ((event) => defaultBroadcast(event));
  // U0.6 — diagnostic log; routes call this on every status mutation so we
  // can correlate UI approval clicks with what actually lands on disk.
  // No-op when running in standalone (no daemon log file).
  const log: LogFn = logFn ?? (() => {});

  // AA4 — daemon's projectHash, computed once at route construction.
  // Undefined when projectRoot wasn't passed (test fixtures); the
  // checkProjectHash helper short-circuits in that case.
  const daemonHash: string | undefined = projectRoot ? projectHashOf(projectRoot) : undefined;

  const app = new Hono();

  // III6 — body-size cap for public mutation routes. Pre-III6 only
  // /api/philosophy/seed had a (DD2) cap; every other POST accepted
  // arbitrary bodies up to whatever the JSON parser would tolerate.
  // One agent-side bug, one hostile script, or one frame-stamped
  // 50MB comment from a misconfigured browser extension could fill
  // .deeppairing/comments.json or .deeppairing/prompts/*.md until
  // the disk ran out. Cap at 64 KiB — a normal artifact / comment
  // / prompt is &lt; 4 KiB; the ceiling allows for verbose markdown
  // pastes without permitting flood. Reads are uncapped (they're
  // bounded by the on-disk state).
  const MAX_BODY_BYTES = 64 * 1024;
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.method === "GET" || c.req.method === "HEAD") {
      return next();
    }
    const lenHeader = c.req.header("content-length");
    if (lenHeader) {
      const len = parseInt(lenHeader, 10);
      if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
        return c.json(
          { error: `Request body exceeds ${MAX_BODY_BYTES}-byte cap.`, code: ERROR_CODES.body_too_large },
          413,
        );
      }
    }
    return next();
  });

  // C-4 — DNS-rebinding guard. The daemon binds 127.0.0.1, but that alone
  // doesn't stop a malicious web page: it can rebind its own domain's DNS to
  // 127.0.0.1, at which point the browser treats it as same-origin (CORS no
  // longer applies) and can read daemon responses — e.g. learn the projectHash
  // from /api/daemon-info, then read arbitrary project files via /api/files.
  // The tell is the Host header: a rebinding request still carries the
  // ATTACKER's domain as Host (the browser sends the name it navigated to),
  // never a loopback name. Reject any present Host whose hostname isn't
  // loopback, before any data is served. Legitimate browser/CLI/WS clients all
  // send localhost / 127.0.0.1 / [::1]. A missing Host (non-browser clients,
  // Hono test requests) isn't the rebinding vector and still falls to the
  // hash/bearer gates below.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host) {
      const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
      const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
      if (!isLoopback) {
        return c.json(
          { error: "Forbidden host — the daemon only serves loopback origins.", code: ERROR_CODES.forbidden_host },
          403,
        );
      }
    }
    return next();
  });

  // AA4 — global middleware. Every route checks X-Project-Hash before
  // doing anything else. CORS preflight (OPTIONS) skips the check —
  // browsers don't send our custom headers on preflight.
  //
  // II2.2 — exempt the browser BOOTSTRAP surface. The II2 fail-closed flip
  // (missing hash → 403) is correct for session state + mutations, where JS
  // sets X-Project-Hash on the fetch/XHR/WS. But it ALSO fired on the
  // requests the browser makes via plain NAVIGATION, which cannot carry
  // custom headers — 403'ing the page out of existence before any JS runs:
  //   - GET / and any non-/api GET → the SPA document + /assets/* bundle
  //   - GET /api/daemon-info → the read-only discovery endpoint the SPA and
  //     the HH4 stale-tab self-heal use to LEARN the hash (gating it is a
  //     chicken-and-egg: you need the daemon's hash to ask it for its hash)
  // None of these touch a session store, so the AA4 wrong-store threat model
  // doesn't apply. Everything else (session state + mutations) stays gated.
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const p = c.req.path;
    const isBootstrap =
      c.req.method === "GET" &&
      (!p.startsWith("/api/") ||
        p === "/api/daemon-info" ||
        // MP1 — read-only cross-daemon discovery (project switcher). Returns no
        // session data (just peer projectRoot/port/hash), so the wrong-store
        // threat model doesn't apply; and it can't be hash-gated because the
        // SPA may query it for a project whose hash it doesn't hold yet.
        p === "/api/projects");
    // FD-2 — the scripted `init demo` is a cold-clone entry point: the user has
    // no project hash to send (no browser tab, no registered session). Its
    // handler (daemon.ts) only ever creates a throwaway `demo_<ts>` session and
    // never targets an existing store, so the AA4 wrong-store threat model
    // doesn't apply — same justification as the discovery routes above. Exempt
    // it so the hero demo works on a fresh clone instead of fail-closed 403ing.
    // (This is a POST, hence handled separately from the GET-only bootstrap set.)
    const isDemoRun = p === "/api/demo/run";
    if (isBootstrap || isDemoRun) return next();
    const hashFail = checkProjectHash(c, daemonHash);
    if (hashFail) return hashFail;
    return next();
  });

  // SP1 — bearer-gate every public MUTATION (non-GET) route. Pre-SP1 these were
  // gated only by the non-secret X-Project-Hash (handed out unauthenticated via
  // /api/daemon-info), so a same-uid sandboxed process — network, no filesystem,
  // the exact II1/III5 adversary — could forge "a human approved this"
  // (POST /api/artifacts/:id/status), forge a decision pick, inject comments, or
  // poison the cross-project ledger (POST /api/philosophy/seed). The same bearer
  // /api/files + /api/prompts already require now covers the whole mutation
  // surface. Reads stay hash-gated (the browser holds the token via
  // window.__deepPairingToken → Authorization, added to sessionHeaders). No-op
  // when authToken is undefined (test fixtures); /api/demo/run stays exempt
  // (intentionally unauthenticated cold-clone entry point).
  app.use("*", async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    if (c.req.path === "/api/demo/run") return next();
    if (authToken) {
      if (c.req.header("Authorization") !== `Bearer ${authToken}`) {
        return c.json(
          { error: "Authorization required for this action.", code: ERROR_CODES.daemon_auth_required },
          401,
        );
      }
    }
    return next();
  });

  app.use("/*", cors({
    // D5 — vscode-webview:// ONLY (see origin-policy.ts). Loopback-origin
    // reflection let any local web page read responses cross-origin —
    // including the served HTML with the injected bearer token.
    origin: (origin) => corsAllowedOrigin(origin) as unknown as string,
  }));

  app.onError((err, c) => {
    if (err instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    return c.json({ error: "Internal server error" }, 500);
  });

  // U0.6 — small helper for mutation routes. If no session is active yet,
  // return 409 with a structured error instead of silently spawning a
  // placeholder. The frontend uses `error.code === "no_active_session"` to
  // surface a "start Claude Code with deepPairing" banner.
  const NO_SESSION_RESPONSE = {
    error: "No active deepPairing session. Start Claude Code with deepPairing configured to create one.",
    code: ERROR_CODES.no_active_session,
  };

  // Full state for initial web UI hydration. Read route — gracefully returns
  // an empty/no-session state instead of 409 so the UI can render its
  // "waiting for Claude Code" surface on first paint.
  app.get("/api/state", async (c) => {
    const store = getStore(getSessionId(c));
    if (!store) return c.json(EMPTY_STATE);
    return c.json(await store.getFullState());
  });

  // Submit a comment from the web UI
  app.post("/api/comments", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    // U2 — validate at the boundary; replaces ad-hoc `if (!artifactId)` guards
    // that left malformed bodies to crash deeper in the handler.
    // H2-2 (#145) — malformed body → honest generic 400 (never the misleading
    // "expected object, received null"); a valid-JSON-but-wrong-shape body still
    // runs through safeParse and yields its Zod field-level error.
    const bodyVal = await readJsonValue(c);
    if (!bodyVal.ok) return bodyVal.res;
    const parsed = CommentBodySchema.safeParse(bodyVal.value);
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    const { artifactId, content, target, intent, parentCommentId } = parsed.data;

    // F6 — an artifact-targeted comment stored into a session that doesn't
    // own the artifact is WORSE than a no-op: it renders in the merged UI
    // (looks successful forever) while the owning agent's check_feedback
    // never sees it. Session-level comments (__session__) are exempt.
    // Review NIT — also guard target.artifactId: {artifactId:"__session__",
    // target:{artifactId:"art_foreign"}} would otherwise bypass into the
    // wrong-session-store case. Current clients send them equal; this is
    // defense-in-depth for hand-rolled callers.
    const targetArtifactId = (target as { artifactId?: string } | undefined)?.artifactId;
    const idsToOwn = [artifactId, targetArtifactId].filter(
      (id): id is string => !!id && id !== "__session__",
    );
    if (idsToOwn.length > 0) {
      const arts = await store.getArtifacts();
      const owns = idsToOwn.every((id) => arts.some((a) => a.id === id));
      if (!owns) {
        return c.json(
          { error: "artifact_not_in_session", code: "artifact_not_in_session",
            message: "This artifact belongs to a different session than the one this tab is bound to." },
          404,
        );
      }
    }

    const newId = `cmt_${nanoid(10)}`;
    const comment = await store.addComment({
      id: newId,
      artifactId,
      content,
      author: "human",
      target,
      intent,
      parentCommentId: parentCommentId ?? null,
    });

    // U0.1 — when addComment dedupes, it returns the existing comment whose
    // id != newId. Skip the broadcast in that case (the original comment
    // already broadcast 5s ago) so the UI doesn't see redundant
    // comment_added/feedback_received events for the same content.
    const isNew = comment.id === newId;
    if (isNew) {
      broadcast({ type: "comment_added", comment }, sid);
      // Q5: a synthetic "I see you" — the server acknowledges the human's
      // comment immediately so the UI can show a pair-tempo pip. The agent
      // won't SEE it until its next check_feedback poll (≤30s), but server-
      // receipt is a useful signal on its own: the message left the human's
      // hand, entered the pair session, and will be surfaced to the agent.
      broadcast({
        type: "feedback_received",
        commentId: comment.id,
        artifactId,
        intent: intent ?? "comment",
      }, sid);
    } else {
      // IV6 — was: ` content="${content.slice(0, 40)}"`. III7 added log
      // rotation but rotation doesn't redact; 40 chars is enough for a
      // leaked password prefix or an API-key fragment in the comment
      // body. The diagnostic value (knowing WHICH dedupe fired) is
      // preserved by the artifactId + reusedId — the content itself is
      // unnecessary and the only user-content leak the rotated log
      // was still writing.
      log(`[comment] DEDUPED — sid=${sid ?? "(none)"} artifactId=${artifactId} reusedId=${comment.id} len=${content.length}`);
    }
    // R1: Q3's horizon-check trigger fires as a question-intent comment
    // with sectionId "horizon_check:request:<horizon>". The broadcast
    // interceptor doesn't see sectionId (feedback_received is trimmed),
    // so we count it inline here.
    if (projectRoot) {
      const sectionId = (target as any)?.sectionId;
      if (typeof sectionId === "string" && sectionId.startsWith("horizon_check:request:")) {
        try { recordMetricEvent(projectRoot, { kind: "horizon_check_requested" }); } catch {}
      }
    }
    return c.json({ comment });
  });

  // Mark a human's OWN unanswered question resolved (human-side "I'm done
  // waiting" — they figured it out or it's no longer relevant). VISIBILITY /
  // waiting-signal only: sets humanResolvedAt; never touches `acknowledged`
  // (the agent's drain queue) or artifact status.
  app.post("/api/comments/:commentId/mark-resolved", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    const commentId = c.req.param("commentId");
    // F6 review — the fifth mutation route with the silent-no-op class: an
    // unknown comment (owned by another session) used to no-op and return
    // 200 {comment: null}; the optimistic stamp then resurrected the
    // question into the waiting set on reload. Fail loudly.
    if (!(await store.getComment(commentId))) {
      return c.json(
        { error: "comment_not_in_session", code: "comment_not_in_session",
          message: "This comment belongs to a different session than the one this tab is bound to." },
        404,
      );
    }
    const resolvedAt = new Date().toISOString();
    await store.markCommentHumanResolved(commentId, resolvedAt);
    const comment = await store.getComment(commentId);
    if (comment) {
      broadcast({ type: "comment_updated", comment }, sid);
    }
    return c.json({ status: "resolved", commentId, comment: comment ?? null });
  });

  // Resolve a decision from the web UI
  app.post("/api/decisions/:decisionId", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    const decisionId = c.req.param("decisionId");
    // H2-2 (#145) — see /api/comments: honest generic 400 on a malformed
    // body, Zod field-level errors preserved on a valid-but-wrong-shape body.
    const bodyVal = await readJsonValue(c);
    if (!bodyVal.ok) return bodyVal.res;
    const parsed = DecisionResolveBodySchema.safeParse(bodyVal.value);
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    const { optionId, reasoning, confidence, predictedOutcome } = parsed.data;

    // F6 — a decision this store doesn't know (no record AND no artifact
    // carrying the decisionId) means the tab is bound to a different session
    // than the one that owns this decision. Fail loudly instead of a 200
    // that resolves nothing (round-4 review: the F2 guard was silently
    // SKIPPED in exactly this case).
    const knownRecord = await store.getDecision(decisionId);
    const knownArtifact = (await store.getArtifacts()).some(
      (a) =>
        a.type === "decision" &&
        ((a.content as { decisionId?: string } | null)?.decisionId === decisionId || a.id === decisionId),
    );
    if (!knownRecord && !knownArtifact) {
      return c.json(
        { error: "decision_not_in_session", code: "decision_not_in_session",
          message: "This decision belongs to a different session than the one this tab is bound to." },
        404,
      );
    }

    const prediction = confidence || predictedOutcome
      ? { confidence, predictedOutcome }
      : undefined;
    await store.resolveDecision(decisionId, optionId, reasoning, prediction);

    // Prefer the decision RECORD's artifactId, but fall back to the decision
    // artifact carrying this decisionId when no record is found. The daemon
    // and the MCP server are separate processes sharing the file store (see
    // X6), so the daemon's decisions map can legitimately lag/miss a record
    // the artifact already references — without this fallback the route
    // returns 200 "resolved" yet leaves the artifact stuck in draft, so it
    // keeps showing as "waiting for you" even though the choice was made.
    const decision = await store.getDecision(decisionId);

    // F2 — when a record EXISTS, resolveDecision ignores an optionId that isn't
    // one of its options (fail-closed). Honor that: don't flip the artifact to
    // approved (a split state — artifact approved, record eternally pending);
    // surface a 400 instead of a misleading 200. When there's NO record (the
    // artifact-only fallback above), skip the guard and let the flip proceed.
    if (decision && (await store.getDecisionResponse(decisionId))?.optionId !== optionId) {
      return c.json(
        { error: `optionId "${optionId}" is not an option of decision ${decisionId}`, code: ERROR_CODES.validation_error },
        400,
      );
    }

    // Flip the decision ARTIFACT to approved so it leaves the "waiting" set.
    let targetArtifactId = decision?.artifactId;
    if (!targetArtifactId) {
      const artifacts = await store.getArtifacts();
      const art = artifacts.find(
        (a) =>
          a.type === "decision" &&
          ((a.content as any)?.decisionId === decisionId || a.id === decisionId),
      );
      targetArtifactId = art?.id;
    }
    if (targetArtifactId) {
      await store.updateArtifactStatus(targetArtifactId, "approved", "ui_decision_resolve" as any);
      // X6 — emission seam: HTTP-side mutations pass null for `server`
      // (the MCP server lives in the daemon's separate process). Today
      // a no-op; future Tasks impl can route via the daemon broadcast.
      await maybeUpdateTaskStatus(null, targetArtifactId, store);
    }

    broadcast({
      type: "decision_resolved",
      decisionId,
      artifactId: targetArtifactId,
      optionId,
      reasoning,
    }, sid);

    return c.json({ status: "resolved", decisionId });
  });

  // Approve/revise/reject a plan from the web UI
  app.post("/api/artifacts/:artifactId/status", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    // AA7b — getSessionId is on IStore, the cast was dead weight.
    const storeSid = store.getSessionId?.() ?? "(unknown)";
    const artifactId = c.req.param("artifactId");
    // H2-2 (#145) — see /api/comments: honest generic 400 on a malformed
    // body, Zod field-level errors preserved on a valid-but-wrong-shape body.
    const bodyVal = await readJsonValue(c);
    if (!bodyVal.ok) return bodyVal.res;
    const parsed = StatusUpdateBodySchema.safeParse(bodyVal.value);
    if (!parsed.success) {
      log(`[status] REJECTED — body schema invalid for ${artifactId} (header.sid=${sid ?? "(none)"}, store.sid=${storeSid}): ${parsed.error.issues[0]?.message}`);
      return c.json(formatZodIssues(parsed.error), 400);
    }
    const { status, feedback, concept: humanConcept } = parsed.data;

    // U0.6 diagnostic — log the routing decision so we can confirm whether
    // the UI's X-Session-Id matches the store the artifact actually lives
    // in. If they differ (hypothesis A), the mutation lands in the wrong
    // store and the agent's wrapper polling a different session never sees
    // the approval.
    const artsBefore = await store.getArtifacts();
    const target = artsBefore.find((a) => a.id === artifactId);
    // U7 — tag the transition with WHO/WHAT triggered it. This route
    // exclusively serves the companion UI, so we map status → ui_*_button.
    const reason =
      status === "approved" ? "ui_approve_button" :
      status === "revised" ? "ui_revise_button" :
      status === "obsolete" ? "ui_dismiss_obsolete" :
      "ui_reject_button";
    log(
      `[status] header.sid=${sid ?? "(none)"} store.sid=${storeSid} artifactId=${artifactId} ` +
      `targetFound=${!!target} fromStatus=${target?.status ?? "(missing)"} toStatus=${status} reason=${reason}`,
    );

    // F6 — hypothesis A, CONFIRMED in the round-4 review: the U0.6 log above
    // fired with targetFound=false and the route still returned 200 while
    // updateArtifactStatus silently no-op'd. A verdict on an artifact this
    // store doesn't own must FAIL LOUDLY (the UI's safeFetch toasts non-2xx
    // and rolls back the optimistic flip) — never report success for a write
    // that didn't land.
    if (!target) {
      return c.json(
        { error: "artifact_not_in_session", code: "artifact_not_in_session",
          message: "This artifact belongs to a different session than the one this tab is bound to." },
        404,
      );
    }

    await store.updateArtifactStatus(artifactId, status, reason as any);
    // "obsolete" is a dismissal, not a plan-review verdict — don't resolve a
    // plan review with it (and it narrows status to the three verdicts).
    if (status !== "obsolete") {
      await store.resolvePlanReview(artifactId, status, feedback);
    }
    // X6 — see comment above; HTTP-side mutations pass null for `server`.
    await maybeUpdateTaskStatus(null, artifactId, store);

    // U0.6 — force the debounced flush so the Stop hook (which reads
    // .deeppairing/sessions/*/artifacts.json directly from disk) sees the
    // new status before its next tick. Without this, a 100ms debounce window
    // can mean the hook reads stale `draft` and traps the agent in a poll
    // loop even though the user just approved.
    // AA7b — forceFlush is required on IStore, no cast needed.
    // F10 review — the split-state class must not escape via persistence: the
    // verdict already landed in memory and notifyFeedbackWaiters released the
    // agent's check_feedback, so a disk throw here (ENOSPC/EACCES/dir-removed
    // race) must NOT 500 the route — the UI would roll back and toast failure
    // for a verdict the agent is already acting on. Log loudly, return 200;
    // the debounced flush self-corrects persistence on the next write.
    try {
      await store.forceFlush();
    } catch (err) {
      console.error(`[deepPairing] verdict flush failed (verdict landed in memory; debounced flush will retry): ${err}`);
    }

    if (feedback) {
      const comment = await store.addComment({
        id: `cmt_${nanoid(10)}`,
        artifactId,
        content: feedback,
        author: "human",
      });
      broadcast({ type: "comment_added", comment }, sid);
    }

    // When a non-decision artifact is rejected, remember the approach so
    // pre-flight blocks any future re-proposal. Description is the artifact
    // title; reason is the feedback comment (required client-side).
    if (status === "rejected") {
      const artifacts = await store.getArtifacts();
      const artifact = artifacts.find((a) => a.id === artifactId);
      if (artifact && artifact.type !== "decision") {
        // The cross-project ledger key, in priority order:
        //   1. the HUMAN-named concept from the reject prompt (the whole point
        //      — the user phrases the pattern they're rejecting, so a future
        //      paraphrase gets caught), then
        //   2. AA1 — the artifact's own Y5-style concept (code_change carries
        //      one today; spec/plan may in future), then
        //   3. the artifact title (legacy fallback).
        const artConcept: string | undefined = (artifact.content as any)?.concept?.name;
        const concept = humanConcept?.trim() || artConcept || undefined;
        await store.recordRejectedApproach({
          description: artifact.title,
          reason: feedback?.trim() || undefined,
          sourceArtifactId: artifactId,
          concept,
        });
        broadcast({
          type: "ledger_write",
          kind: "rejected",
          description: artifact.title,
          concept,
          reason: feedback?.trim() || undefined,
          sourceArtifactId: artifactId,
        }, sid);
      }
    }

    broadcast({ type: "artifact_updated", artifactId, status }, sid);

    return c.json({ status: "updated", artifactId });
  });

  // Rename an artifact
  app.post("/api/artifacts/:artifactId/rename", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    const artifactId = c.req.param("artifactId");
    // H2-2 (#145) — see /api/comments: honest generic 400 on a malformed
    // body, Zod field-level errors preserved on a valid-but-wrong-shape body.
    const bodyVal = await readJsonValue(c);
    if (!bodyVal.ok) return bodyVal.res;
    const parsed = RenameBodySchema.safeParse(bodyVal.value);
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    const title = parsed.data.title.trim();
    // F6 — same cross-session guard as status/comments/decisions.
    if (!(await store.getArtifacts()).some((a) => a.id === artifactId)) {
      return c.json(
        { error: "artifact_not_in_session", code: "artifact_not_in_session",
          message: "This artifact belongs to a different session than the one this tab is bound to." },
        404,
      );
    }
    await store.renameArtifact(artifactId, title);
    broadcast({ type: "artifact_renamed", artifactId, title }, sid);
    return c.json({ status: "renamed", artifactId });
  });

  // Get comments for an artifact
  app.get("/api/artifacts/:artifactId/comments", async (c) => {
    const store = getStore(getSessionId(c));
    if (!store) return c.json({ comments: [] });
    const artifactId = c.req.param("artifactId");
    return c.json({ comments: await store.getCommentsForArtifact(artifactId) });
  });

  // Y1' — preflight trace for an artifact. Drives the "Cross-checked your N
  // prior stances" breadcrumb in ArtifactPanel.
  // Z1 — getPreflightTrace is now properly optional on IStore (was a cast
  // pre-Z1). DaemonClient implements it; older artifacts that predate Y1'
  // return null.
  app.get("/api/artifacts/:artifactId/preflight-trace", async (c) => {
    const store = getStore(getSessionId(c));
    if (!store) return c.json({ trace: null });
    const artifactId = c.req.param("artifactId");
    if (!store.getPreflightTrace) return c.json({ trace: null });
    const trace = await store.getPreflightTrace(artifactId);
    return c.json({ trace: trace ?? null });
  });

  // N3.1: Philosophy ledger (cross-project, shared across all sessions).
  // Powers the "Your taste" drawer. Read-only — mutations happen via the
  // MCP tools during live sessions.
  app.get("/api/philosophy", (c) => {
    const stance = c.req.query("stance") as "avoid" | "prefer" | "mixed" | undefined;
    const concept = c.req.query("concept") ?? undefined;
    const limit = Number(c.req.query("limit") ?? 50);
    // H1-5(c) — query() reads the on-disk global ledger; a future shape bug
    // there must DEGRADE this taste route to empty, not 500 it. (Read-only,
    // safe to return []).
    let entries;
    try {
      entries = getGlobalStore().query({
        stance: stance && ["avoid", "prefer", "mixed"].includes(stance) ? stance : undefined,
        concept,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50,
      });
    } catch (err) {
      log(`[philosophy] query failed, returning empty: ${err}`);
      return c.json({ entries: [], total: 0 });
    }
    // Trim to the bits the UI needs so we don't ship every full instance
    // history on page load. The drawer can click-to-expand for details.
    const summary = entries.map((e) => {
      const projects = new Set(e.instances.map((i) => i.project));
      const latestReason = [...e.instances].reverse().find((i) => i.reason)?.reason;
      const verdicts = e.instances.reduce(
        (acc, i) => { acc[i.verdict]++; return acc; },
        { approved: 0, rejected: 0 } as { approved: number; rejected: number },
      );
      return {
        key: e.key,
        concept: e.concept,
        stance: e.stance,
        projectCount: projects.size,
        projects: Array.from(projects).slice(0, 5), // surface the first few
        instanceCount: e.instances.length,
        approved: verdicts.approved,
        rejected: verdicts.rejected,
        latestReason,
        firstSeenAt: e.firstSeenAt,
        lastSeenAt: e.lastSeenAt,
      };
    });
    return c.json({ entries: summary, total: summary.length });
  });

  // N3.2: Weekly Ledger Digest — what compounded in your Philosophy Ledger
  // over the last N days. Point is to make the moat felt: the user sees the
  // AA9 — manual ledger seed. PMF council deep dive resolution: instead
  // of pre-seeded stance picks ("I prefer composition over inheritance"
  // — opinionated, anti-thesis), let the user paste a rule from their
  // CLAUDE.md / code-review checklist / team doc. The pasted text
  // becomes a recordInstance call with synthetic project="manual" +
  // sessionId="seed" + the verdict the user chose.
  //
  // Active accumulation, zero presupposed taste. The synthetic
  // project/sessionId distinguish manual seeds from real session-driven
  // entries so we can later filter ("3 of your 47 stances were
  // manually seeded") without conflating the two.
  app.post("/api/philosophy/seed", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch {
      return c.json({ error: "invalid JSON body", code: ERROR_CODES.validation_error }, 400);
    }
    const raw = String(body?.concept ?? "");
    const verdict = body?.verdict === "rejected" ? "rejected" : "approved";
    const reason = body?.reason ? String(body.reason).trim() || undefined : undefined;
    // DD2 — body-size + line-count caps. CC7 amplified AA#5: one POST
    // could insert hundreds of entries unbounded. The cap closes the
    // amplification factor without needing a per-IP rate limiter (which
    // is overkill for a localhost-only daemon). 16 KiB body cap ≈ a
    // very generous CLAUDE.md paste; 50-line cap forces batching for
    // anything larger and gives the user a clear validation error
    // instead of a silently-overflowing ledger.
    const MAX_BODY_BYTES = 16 * 1024;
    const MAX_LINES = 50;
    // EE8 — measure UTF-8 bytes, not UTF-16 code units. Pre-EE8 the
    // cap compared raw.length (string code units) against a value
    // labeled "bytes". Direction was permissive: a non-ASCII paste
    // (CJK, emoji) hit the cap at ~16384 chars = up to 64 KB actual
    // UTF-8 — looser limit for non-ASCII users, but still wrong-shaped.
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return c.json(
        {
          error: `seed body exceeds ${MAX_BODY_BYTES} bytes — paste in smaller batches.`,
          code: ERROR_CODES.validation_error,
        },
        400,
      );
    }
    // CC7 — split on newlines, treat each line as a separate stance. PMF
    // council flagged the tokenization cliff: a long-form paste like
    // "avoid global mutable state — prefer dependency injection so tests
    // can swap impls" tokenizes into 8+ ≥4-char tokens, of which a real
    // future proposal will hit 3-4 → tokenCoverage 0.4-0.5 → below the
    // NEAR_MISS_THRESHOLD (0.5) → seed silently never matches. Splitting
    // on newlines lets the user paste a rule list (one rule per line)
    // and each entry has a tight token set the validator can actually
    // hit. Backward compatible: a single-line paste seeds one entry,
    // identical to pre-CC7 behavior.
    const lines = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (lines.length > MAX_LINES) {
      return c.json(
        {
          error: `seed exceeds ${MAX_LINES} lines (got ${lines.length}) — paste in smaller batches.`,
          code: ERROR_CODES.validation_error,
        },
        400,
      );
    }
    const seenInThisPost = new Set<string>();
    const concepts = lines.filter((l) => {
      const k = l.toLowerCase();
      if (seenInThisPost.has(k)) return false;
      seenInThisPost.add(k);
      return true;
    });
    if (concepts.length === 0) {
      return c.json(
        { error: "concept is required (paste a rule, idea, or pattern name)", code: ERROR_CODES.validation_error },
        400,
      );
    }
    for (const concept of concepts) {
      getGlobalStore().recordInstance(concept, {
        project: "manual",
        sessionId: "seed",
        verdict,
        reason,
        description: reason ?? concept,
      });
    }
    // Backward-compatible single-entry shape; expose count + concepts so
    // newer callers can render "Seeded 3 stances". Older test fixtures
    // checking { status, concept, verdict } still pass — `concept` is
    // the first one for compatibility.
    return c.json({
      status: "seeded",
      concept: concepts[0],
      concepts,
      seededCount: concepts.length,
      verdict,
    });
  });

  // Scope-down (override) a personal pre-flight block the user judges a false
  // positive. The gate is fuzzy by design, so wrong blocks are guaranteed —
  // this is the safety valve. Retires the matching local stance (clears the
  // block in THIS project now) and records an `approved` counter-instance in
  // the global ledger (shifts the derived stance off "avoid" for future
  // projects), keeping append-only history. See FileStore.overrideRejectedApproach.
  app.post("/api/philosophy/override", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body", code: ERROR_CODES.validation_error }, 400);
    }
    // v1 boundary: team-rule blocks live in committed .deeppairing/team.json.
    // Overriding one silently mutates shared, version-controlled config, so we
    // don't — the UI surfaces "edit team.json" for team-source blocks and
    // shouldn't reach here. Guard defensively anyway.
    if (body?.source === "team") {
      return c.json(
        {
          error:
            "Team-rule blocks can't be overridden here — edit .deeppairing/team.json (it's shared and committed).",
          code: ERROR_CODES.validation_error,
        },
        400,
      );
    }
    const description = typeof body?.description === "string" ? body.description : undefined;
    const concept = typeof body?.concept === "string" ? body.concept : undefined;
    if (!description && !concept) {
      return c.json(
        { error: "description or concept is required to identify the stance", code: ERROR_CODES.validation_error },
        400,
      );
    }
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) {
      return c.json(
        { error: "No active session to override against.", code: ERROR_CODES.no_active_session },
        409,
      );
    }
    const result = await store.overrideRejectedApproach({ description, concept });
    // Tell the connected UI the ledger changed so digests/drawer refresh and
    // the tempo layer can confirm the override landed.
    broadcast({ type: "stance_overridden", concept: concept ?? description, retired: result.retired }, sid);
    return c.json({ status: "overridden", concept: concept ?? description, ...result });
  });

  app.get("/api/philosophy/digest", (c) => {
    const sinceDays = Math.min(Math.max(Number(c.req.query("sinceDays") ?? 7), 1), 90);
    const now = Date.now();
    const fromMs = now - sinceDays * 24 * 60 * 60 * 1000;
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(now).toISOString();

    // Pull a wide slice — the digest computes its own breakdowns.
    // H1-5(c) — degrade to an empty digest rather than 500 if the ledger read
    // ever throws on a future shape bug.
    let entries;
    try {
      entries = getGlobalStore().query({ limit: 500 });
    } catch (err) {
      log(`[philosophy/digest] query failed, returning empty digest: ${err}`);
      return c.json({
        window: { sinceDays, fromIso, toIso },
        totals: { concepts: 0, instances: 0, multiProjectConcepts: 0 },
        newThisPeriod: [],
        strengthenedThisPeriod: [],
      });
    }

    // BB1 — synthetic project="manual" markers (AA9 seeds) must NOT
    // count as a real project in cross-project totals. Otherwise a
    // fresh install with one seed renders "1 projects total" and one
    // seed + a real session of the same concept fires the false
    // multi-project badge.
    const realProjects = (insts: { project: string }[]) =>
      new Set(insts.filter((i) => i.project !== "manual").map((i) => i.project));

    const totals = {
      concepts: entries.length,
      instances: entries.reduce((a, e) => a + e.instances.length, 0),
      multiProjectConcepts: entries.filter((e) => realProjects(e.instances).size > 1).length,
    };

    const mapEntry = (e: typeof entries[number]) => {
      const projects = realProjects(e.instances);
      const latestReason = [...e.instances].reverse().find((i) => i.reason)?.reason;
      return {
        key: e.key,
        concept: e.concept,
        stance: e.stance,
        projectCount: projects.size,
        firstSeenAt: e.firstSeenAt,
        lastSeenAt: e.lastSeenAt,
        latestReason,
      };
    };

    const newThisPeriod = entries
      .filter((e) => new Date(e.firstSeenAt).getTime() >= fromMs)
      .map(mapEntry);

    const strengthenedThisPeriod = entries
      .filter((e) => new Date(e.firstSeenAt).getTime() < fromMs)
      .map((e) => {
        const newInstancesInPeriod = e.instances.filter((i) => new Date(i.at).getTime() >= fromMs).length;
        return { ...mapEntry(e), newInstancesInPeriod };
      })
      .filter((e) => e.newInstancesInPeriod > 0);

    return c.json({
      window: { sinceDays, fromIso, toIso },
      totals,
      newThisPeriod,
      strengthenedThisPeriod,
    });
  });

  // N3.3: past-predictions lookup. Powers the breadcrumb above high-stakes
  // decisions that asks "you predicted X on a similar decision N months ago".
  // Project-scoped (walks .deeppairing/sessions/*); returns empty if the
  // daemon wasn't started with a projectRoot.
  app.get("/api/predictions", (c) => {
    const concept = (c.req.query("concept") ?? "").trim();
    const excludeArtifactId = c.req.query("excludeArtifactId") ?? undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 3), 1), 10);
    if (!concept || !projectRoot) {
      return c.json({ predictions: [] });
    }
    const predictions = FileStore.findPastPredictions(projectRoot, concept, {
      excludeArtifactId,
      limit,
    });
    return c.json({ predictions });
  });

  // AA5 — ledger digest. The cross-project moat surface that Z1's
  // durable preflight traces unlocked. Aggregates every trace across
  // every session in this project + the global Philosophy Ledger so
  // the YourTaste drawer's Ledger view can render:
  //   - "N proposals shaped this project across M sessions"
  //   - "N near-misses caught" / "N blocks fired"
  //   - top stances by citation count, with a sample artifact to jump to.
  //
  // This is the move Cursor 3 / Claude Code auto-memory structurally
  // cannot ship — they don't store rejection-reasoning as first-class
  // objects, so they have nothing to aggregate.
  app.get("/api/ledger/digest", (c) => {
    if (!projectRoot) {
      // Degraded shape — daemon was constructed without projectRoot
      // (test fixtures, plugin install with bad cwd). Return zeros so
      // the UI can render "your ledger will start filling in as you
      // pair" without a blank state.
      return c.json({
        shapedThisProject: 0,
        nearMissesThisProject: 0,
        blockedThisProject: 0,
        sessionsTouched: 0,
        topCitedStances: [],
        seededStances: [],
        globalLedger: { concepts: 0, projects: 0, multiProjectConcepts: 0 },
      });
    }
    // H1-5(c) — both reads touch the on-disk ledgers; a future shape bug must
    // degrade this route to the same zeros shape as the no-projectRoot branch
    // above, not 500. Only the two disk reads can throw; the fold below runs on
    // validated in-memory data.
    let project: ReturnType<typeof FileStore.ledgerDigest>;
    let entries;
    try {
      project = FileStore.ledgerDigest(projectRoot);
      entries = getGlobalStore().query({ limit: 10000 });
    } catch (err) {
      log(`[ledger/digest] read failed, returning empty digest: ${err}`);
      return c.json({
        shapedThisProject: 0,
        nearMissesThisProject: 0,
        blockedThisProject: 0,
        sessionsTouched: 0,
        topCitedStances: [],
        seededStances: [],
        globalLedger: { concepts: 0, projects: 0, multiProjectConcepts: 0 },
      });
    }
    // FF6 — single-pass fold over entries. Pre-FF6 the same array was
    // walked four separate times (projects Set, multiProjectConcepts
    // filter with per-entry Set allocation, seededStances filter+map,
    // globalCitationByConcept Map). At limit=10000 with ~5 instances
    // per entry, that was ~200k Set allocations per request. The
    // BB2 server cache (TTL 2s) absorbed steady-state but cold-cache
    // was hot. One loop fills:
    //   - projects: distinct non-manual projects across all entries
    //     (BB1 — exclude project="manual" seed markers)
    //   - multiProjectConcepts: entries whose own non-manual project
    //     count is > 1 (counted inline via per-entry Set, but only
    //     allocated when the entry has ≥2 instances)
    //   - globalCitationByConcept: EE3 cross-project citation count
    //     per concept (real instances only)
    //   - seededRaw: entries flagged by isSeededEntry, holding the
    //     non-manual instance count for citedTimesElsewhere
    const projects = new Set<string>();
    let multiProjectConcepts = 0;
    const globalCitationByConcept = new Map<string, number>();
    const seededRaw: Array<{ concept: string; stance: typeof entries[number]["stance"]; citedTimesElsewhere: number }> = [];
    for (const e of entries) {
      let realInstanceCount = 0;
      let entryProjects: Set<string> | null = null;
      for (const inst of e.instances) {
        if (inst.project === "manual") continue;
        realInstanceCount++;
        projects.add(inst.project);
        // Allocate the per-entry Set only when we already know there's
        // at least 2 instances — saves the alloc for solo-entry stances
        // (the common case).
        if (realInstanceCount === 2 && !entryProjects) {
          entryProjects = new Set<string>();
          for (const prior of e.instances) {
            if (prior.project !== "manual") entryProjects.add(prior.project);
          }
        } else if (entryProjects) {
          entryProjects.add(inst.project);
        }
      }
      if (entryProjects && entryProjects.size > 1) multiProjectConcepts++;
      if (realInstanceCount > 0) globalCitationByConcept.set(e.concept, realInstanceCount);
      if (isSeededEntry(e)) {
        seededRaw.push({
          concept: e.concept,
          stance: e.stance,
          citedTimesElsewhere: realInstanceCount,
        });
      }
    }
    // FF1 — concept→sample lookup from project-scoped topCitedStances
    // so seeded rows that have been cited in this project can render
    // the BB6 deep-link button. Cheap separate pass — small array.
    const sampleByConcept = new Map<string, { sampleArtifactId?: string; sampleSessionId?: string }>();
    for (const s of project.topCitedStances) {
      if (s.sampleArtifactId) {
        sampleByConcept.set(s.concept, {
          sampleArtifactId: s.sampleArtifactId,
          sampleSessionId: s.sampleSessionId,
        });
      }
    }
    const seededStances = seededRaw.map((s) => {
      const sample = sampleByConcept.get(s.concept);
      return {
        ...s,
        sampleArtifactId: sample?.sampleArtifactId,
        sampleSessionId: sample?.sampleSessionId,
      };
    });
    const topCitedStancesWithGlobal = project.topCitedStances.map((s) => ({
      ...s,
      globalCitationCount: globalCitationByConcept.get(s.concept) ?? s.citationCount,
    }));
    return c.json({
      ...project,
      topCitedStances: topCitedStancesWithGlobal,
      seededStances,
      globalLedger: {
        concepts: entries.length,
        projects: projects.size,
        multiProjectConcepts,
      },
    });
  });

  // R1: local telemetry surface. Read-only snapshot of the counts the
  // daemon has been writing to `.deeppairing/metrics.json` as events
  // flow through broadcast. The UI renders this in Settings → Session
  // metrics so the user can see that the moat is quantifiably building.
  app.get("/api/metrics", (c) => {
    if (!projectRoot) return c.json({ error: "projectRoot not configured" }, 400);
    return c.json(readMetrics(projectRoot));
  });

  // P3: project-scoped team preferences for the companion UI. Reads
  // .deeppairing/team.json via any active session's FileStore (all
  // sessions in a project share the same team.json). Returns both the
  // preferences and an `exists` flag so the UI can nudge `team init`
  // when no file has been created yet.
  app.get("/api/team-preferences", async (c) => {
    const store = getStore(getSessionId(c));
    if (!store) return c.json({ preferences: [], exists: false });
    // AA7b — typed optional method. Async + await for the same
    // MaybePromise reason as the daemon-routes guardrails fix.
    const preferences = (await store.getTeamPreferences?.()) ?? [];
    // "exists" proxy: the file existed at FileStore-construction time if
    // any preference landed; otherwise we need another signal. Simplest
    // truth: a non-empty array implies the file exists. An empty array is
    // ambiguous — treat as "not yet configured" (the UI treats both empty
    // and missing the same way: nudge toward `team init`).
    return c.json({ preferences, exists: preferences.length > 0 });
  });

  // P2: capture a retrospective on a past decision's prediction — the
  // calibration loop closure. Walks sessions to find the owning session
  // and writes into its retrospectives.json, replacing any prior entry
  // for the same decisionId (verdict can change as evidence accumulates).
  app.post("/api/retrospectives", async (c) => {
    if (!projectRoot) return c.json({ error: "projectRoot not configured" }, 400);
    // H2-2 (#145) — see /api/comments: honest generic 400 on a malformed body
    // (not the misleading "received null"), Zod field-level errors preserved.
    const bodyVal = await readJsonValue(c);
    if (!bodyVal.ok) return bodyVal.res;
    const parsed = RetrospectiveBodySchema.safeParse(bodyVal.value);
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    const { decisionId, verdict, note } = parsed.data;
    const result = FileStore.addRetrospective(projectRoot, { decisionId, verdict, note });
    if (!result) {
      return c.json({ error: `no decision found with id "${decisionId}"` }, 404);
    }
    broadcast({
      type: "retrospective_recorded",
      decisionId,
      verdict,
      retrospectiveId: result.retrospective.id,
    }, result.sessionId);
    return c.json({ retrospective: result.retrospective, sessionId: result.sessionId });
  });

  // Export session as markdown
  app.get("/api/export", async (c) => {
    const store = getStore(getSessionId(c));
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    const format = (c.req.query("format") ?? "full") as "full" | "pr-description" | "pr-comments" | "adr" | "replay" | "learnings";
    const state = await store.getFullState();
    const markdown = formatSessionMarkdown(state, format);
    return c.text(markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  // Set preferences (autonomy level, etc.)
  app.post("/api/preferences", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    // H2-2 (#145) — see /api/comments: honest generic 400 on a malformed
    // body, Zod field-level errors preserved on a valid-but-wrong-shape body.
    const bodyVal = await readJsonValue(c);
    if (!bodyVal.ok) return bodyVal.res;
    const parsed = PreferenceBodySchema.safeParse(bodyVal.value);
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    if (parsed.data.autonomyLevel) {
      await store.setAutonomyLevel(parsed.data.autonomyLevel);
      broadcast({ type: "preference_changed", autonomyLevel: parsed.data.autonomyLevel }, sid);
    }
    // #139 — detail density: orthogonal to autonomy, so handle independently
    // (a POST may carry either or both).
    if (parsed.data.detailDensity) {
      await store.setDetailDensity(parsed.data.detailDensity);
      broadcast({ type: "preference_changed", detailDensity: parsed.data.detailDensity }, sid);
    }
    return c.json({ status: "updated" });
  });

  // Read a project file for the FileViewer
  app.get("/api/files", (c) => {
    // C-4 — Bearer-gated like /api/prompts. Reading arbitrary project files is
    // the highest-value read the daemon offers, so the X-Project-Hash gate
    // (the hash is discoverable via /api/daemon-info) isn't enough on its own.
    // Require the daemon's bearer token too; the browser sends it via the
    // window.__deepPairingToken injection (FileViewer attaches it). This raises
    // the bar to "can read .deeppairing/daemon.json" — the same posture III5
    // gave /api/prompts — and, with the Host guard above, closes the
    // DNS-rebinding arbitrary-file-read path.
    if (authToken) {
      const auth = c.req.header("Authorization");
      if (auth !== `Bearer ${authToken}`) {
        log(`[files-auth] 401 — bad/missing Authorization header`);
        return c.json(
          { error: "Authorization required to read project files.", code: ERROR_CODES.daemon_auth_required },
          401,
        );
      }
    }
    const filePath = c.req.query("path");
    if (!filePath || !projectRoot) {
      return c.json({ error: "path parameter required" }, 400);
    }
    const resolved = path.resolve(projectRoot, filePath.startsWith("/") ? filePath.slice(1) : filePath);
    const resolvedRoot = path.resolve(projectRoot);
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
      return c.json({ error: "Path outside project root" }, 403);
    }
    // II3 — defeat symlink escape. The startsWith check above stops literal
    // `../` traversal in the query string, but if a malicious dependency
    // dropped a symlink inside the project (e.g. `pkg/sneaky → /etc/passwd`),
    // path.resolve happily passes containment and fs.readFileSync follows the
    // link. realpath the resolved target and re-check containment against
    // realpath(projectRoot) so symlinks pointing outside the project tree
    // are rejected.
    let realResolved: string;
    let realRoot: string;
    try {
      realResolved = fs.realpathSync(resolved);
      realRoot = fs.realpathSync(resolvedRoot);
    } catch (err: any) {
      if (err?.code === "ENOENT") return c.json({ error: "File not found" }, 404);
      return c.json({ error: "Cannot read file" }, 500);
    }
    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
      return c.json({ error: "Path outside project root" }, 403);
    }
    try {
      // S2 — size-cap the read. The viewer only ever shows source files; without
      // a ceiling a (bearer-holding, same-uid) client could point this at a
      // multi-GB file and OOM the daemon — the whole content is buffered into a
      // string AND split into a lines array. 5 MiB comfortably covers any real
      // source file; larger → 413 rather than a heap blow-up.
      const MAX_FILE_BYTES = 5 * 1024 * 1024;
      const size = fs.statSync(realResolved).size;
      if (size > MAX_FILE_BYTES) {
        return c.json(
          { error: `File too large to view (${size} bytes > ${MAX_FILE_BYTES}-byte cap).`, code: ERROR_CODES.body_too_large },
          413,
        );
      }
      const content = fs.readFileSync(realResolved, "utf-8");
      return c.json({ content, filePath, lines: content.split("\n").length });
    } catch (err: any) {
      if (err?.code === "ENOENT") return c.json({ error: "File not found" }, 404);
      return c.json({ error: "Cannot read file" }, 500);
    }
  });

  // Get session memory (rejected approaches, approved patterns)
  app.get("/api/memory", async (c) => {
    const store = getStore(getSessionId(c));
    if (!store) return c.json({ rejectedApproaches: [], approvedPatterns: [] });
    return c.json(await store.getSessionMemory());
  });

  // X7 — hook fire history. Hooks (.deeppairing/hooks/stop.mjs and
  // checkpoint.mjs) append every fire to .deeppairing/hooks-state.json.
  // The companion UI's HookStatus component polls/subscribes to this so
  // the user can see the hook stack working — not just learn about it
  // when something nags in the terminal.
  app.get("/api/hook-state", (c) => {
    if (!projectRoot) return c.json({ version: 1, fires: [] });
    const statePath = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    if (!fs.existsSync(statePath)) return c.json({ version: 1, fires: [] });
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      // Cap response to last 25 fires — UI only shows ~5 at a time.
      const fires = Array.isArray(raw?.fires) ? raw.fires.slice(-25) : [];
      return c.json({ version: 1, fires });
    } catch {
      return c.json({ version: 1, fires: [] });
    }
  });

  // List past sessions
  app.get("/api/sessions", (c) => {
    if (!projectRoot) return c.json({ sessions: [] });
    const sessions = FileStore.listSessions(projectRoot);
    return c.json({ sessions });
  });

  // #138 — project-wide decisions view. Read-only, project-scoped (walks every
  // session's decisions.json), newest-first, with an HONEST partial-data report
  // (`failedSessions`) so the view never silently truncates when one session's
  // decisions.json is corrupt. Sibling of /api/sessions and /api/search: takes
  // no body and no session lookup, so the AA4 wrong-store threat model doesn't
  // apply — the global X-Project-Hash middleware (registered above, before any
  // handler) is the gate, exactly like the other project-scoped reads. Returns
  // the empty shape when no projectRoot (test fixtures / bad cwd).
  app.get("/api/decisions", (c) => {
    if (!projectRoot) return c.json({ decisions: [], failedSessions: [] });
    // Degrade, don't 500 — same guard the ledger reads use (see /api/philosophy,
    // /api/philosophy/digest, /api/ledger/digest above). listAllDecisions is
    // hardened against per-session corruption, but a future disk-shape bug must
    // never take the whole view down with an opaque 500.
    try {
      return c.json(FileStore.listAllDecisions(projectRoot));
    } catch (err) {
      log(`[decisions] read failed, returning empty: ${err}`);
      return c.json({ decisions: [], failedSessions: [] });
    }
  });

  // Cross-session search
  app.get("/api/search", (c) => {
    if (!projectRoot) return c.json({ results: [] });
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ results: [] });
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const results = FileStore.searchAll(projectRoot, q, limit);
    return c.json({ results });
  });

  // Load a specific past session
  app.get("/api/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    if (!projectRoot) return c.json({ error: "No project root" }, 500);
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    try {
      const state = FileStore.loadSession(projectRoot, sessionId);
      return c.json(state);
    } catch {
      return c.json({ error: "Session not found" }, 404);
    }
  });

  // --- Session annotations (learner's replay notes) ---

  app.get("/api/sessions/:sessionId/annotations", (c) => {
    const sessionId = c.req.param("sessionId");
    if (!projectRoot) return c.json({ annotations: [] });
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    try {
      const s = new FileStore(projectRoot, sessionId);
      return c.json({ annotations: s.getAnnotations() });
    } catch {
      return c.json({ annotations: [] });
    }
  });

  app.post("/api/sessions/:sessionId/annotations", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!projectRoot) return c.json({ error: "No project root" }, 500);
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    // H2-2 (#145) — guard the parse; a malformed body becomes null → the
    // "required" 400 below, never a 500.
    const body = await c.req.json().catch(() => null);
    const { targetEventId, note, tags } = body ?? {};
    if (!targetEventId || !note) {
      return c.json({ error: "targetEventId and note required" }, 400);
    }
    const s = new FileStore(projectRoot, sessionId);
    const annotation = s.addAnnotation({ targetEventId, note, tags });
    return c.json({ annotation });
  });

  // Save a re-pair prompt to .deeppairing/prompts/ so the developer can
  // reference it from their filesystem in a fresh Claude Code session.
  //
  // III5 — Bearer-gated. Pre-III5 this route accepted any X-Project-Hash-
  // bearing call, which a same-uid attacker who scraped daemon.json
  // for the hash could trivially impersonate to plant crafted markdown
  // the user later pastes into Claude Code (a prompt-injection
  // delivery vector). Now requires the daemon's bearer token; the
  // browser UI gets it via window.__deepPairingToken injected into
  // index.html (see daemon.ts).
  app.post("/api/prompts", async (c) => {
    if (!projectRoot) return c.json({ error: "No project root" }, 500);
    if (authToken) {
      const auth = c.req.header("Authorization");
      if (auth !== `Bearer ${authToken}`) {
        log(`[prompts-auth] 401 — bad/missing Authorization header`);
        return c.json(
          { error: "Authorization required for prompt save.", code: ERROR_CODES.daemon_auth_required },
          401,
        );
      }
    }
    // H2-2 (#145) — guard the parse; runs AFTER the bearer gate above so an
    // unauthenticated caller still 401s, never reaching this. A malformed body
    // becomes null → the "content required" 400 below, never a 500.
    const body = await c.req.json().catch(() => null);
    const content = typeof body?.content === "string" ? body.content : "";
    if (!content.trim()) return c.json({ error: "content required" }, 400);

    const sanitize = (s: unknown): string =>
      String(s ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const decisionTag = sanitize(body?.decisionId);
    const sessionTag = sanitize(body?.sessionId);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = [ts, sessionTag, decisionTag].filter(Boolean).join("_") + ".md";

    const promptsDir = path.join(projectRoot, ".deeppairing", "prompts");
    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      const fullPath = path.join(promptsDir, filename);
      // Final safety: resolve and ensure the write stays inside promptsDir.
      const resolved = path.resolve(fullPath);
      const resolvedDir = path.resolve(promptsDir);
      if (!resolved.startsWith(resolvedDir + path.sep)) {
        return c.json({ error: "invalid path" }, 400);
      }
      // II3 — defeat symlink-as-target. An attacker with prior local access
      // can pre-plant `promptsDir/<filename> → /Users/you/.ssh/authorized_keys`
      // and the write follows the symlink (writeFileSync truncates the link
      // target). Reject if the target exists and is a symlink; if it doesn't
      // exist yet, realpath the parent dir and re-check containment so a
      // symlinked promptsDir itself can't escape.
      try {
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink()) return c.json({ error: "invalid path" }, 400);
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }
      const realDir = fs.realpathSync(resolvedDir);
      const realRoot = fs.realpathSync(path.resolve(projectRoot));
      if (!realDir.startsWith(realRoot + path.sep) && realDir !== realRoot) {
        return c.json({ error: "invalid path" }, 400);
      }
      fs.writeFileSync(resolved, content, "utf-8");
      const relPath = path.relative(projectRoot, resolved);
      return c.json({ status: "saved", path: resolved, relPath });
    } catch (err: any) {
      return c.json({ error: err?.message ?? "Save failed" }, 500);
    }
  });

  app.delete("/api/sessions/:sessionId/annotations/:annotationId", (c) => {
    const sessionId = c.req.param("sessionId");
    const annotationId = c.req.param("annotationId");
    if (!projectRoot) return c.json({ error: "No project root" }, 500);
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    const s = new FileStore(projectRoot, sessionId);
    const ok = s.deleteAnnotation(annotationId);
    return c.json({ deleted: ok });
  });

  return app;
}
