import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import type { IStore } from "../store/store-interface.js";
import { FileStore } from "../store/file-store.js";
import { broadcast as defaultBroadcast } from "./websocket.js";
import { formatSessionMarkdown } from "../export/format-markdown.js";
import { getGlobalStore, isSeededEntry } from "../store/global-store.js";
import { projectHashOf } from "../project-root.js";
import { readMetrics, recordMetricEvent } from "../store/metrics-store.js";
import { maybeUpdateTaskStatus } from "../mcp/tasks-probe.js";
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

/** Extract sessionId from X-Session-Id header */
function getSessionId(c: any): string | undefined {
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
function checkProjectHash(c: any, daemonHash: string | undefined): Response | null {
  if (!daemonHash) return null;
  const sentHash = c.req.header("X-Project-Hash");
  if (!sentHash || sentHash !== daemonHash) {
    return c.json(
      {
        // BB10 — message is fallback copy. The browser specializes the
        // toast on `code` and offers a one-click reload action.
        error: `Project hash mismatch — your tab is pointed at a daemon serving a different project. Reload the page to re-bind.`,
        code: "project_hash_mismatch",
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
  rejectedApproaches: [],
  approvedPatterns: [],
} as const;

export function createHttpRoutes(
  storeOrGetter: IStore | StoreGetter,
  projectRoot?: string,
  broadcastFn?: BroadcastFn,
  logFn?: LogFn,
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

  // AA4 — global middleware. Every route checks X-Project-Hash before
  // doing anything else. CORS preflight (OPTIONS) skips the check —
  // browsers don't send our custom headers on preflight.
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const hashFail = checkProjectHash(c, daemonHash);
    if (hashFail) return hashFail;
    return next();
  });

  app.use("/*", cors({
    origin: (origin) => {
      if (!origin) return origin as string;
      try {
        const url = new URL(origin);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
          return origin;
        }
      } catch {}
      return undefined as unknown as string;
    },
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
    code: "no_active_session",
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
    const parsed = CommentBodySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    const { artifactId, content, target, intent, parentCommentId } = parsed.data;

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
      log(`[comment] DEDUPED — sid=${sid ?? "(none)"} artifactId=${artifactId} reusedId=${comment.id} content="${content.slice(0, 40)}"`);
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

  // Resolve a decision from the web UI
  app.post("/api/decisions/:decisionId", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    const decisionId = c.req.param("decisionId");
    const parsed = DecisionResolveBodySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    const { optionId, reasoning, confidence, predictedOutcome } = parsed.data;

    const prediction = confidence || predictedOutcome
      ? { confidence, predictedOutcome }
      : undefined;
    await store.resolveDecision(decisionId, optionId, reasoning, prediction);

    const decision = await store.getDecision(decisionId);
    if (decision) {
      await store.updateArtifactStatus(decision.artifactId, "approved", "ui_decision_resolve" as any);
      // X6 — emission seam: HTTP-side mutations pass null for `server`
      // (the MCP server lives in the daemon's separate process). Today
      // a no-op; future Tasks impl can route via the daemon broadcast.
      await maybeUpdateTaskStatus(null, decision.artifactId, store);
    }

    broadcast({
      type: "decision_resolved",
      decisionId,
      artifactId: decision?.artifactId,
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
    const parsed = StatusUpdateBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      log(`[status] REJECTED — body schema invalid for ${artifactId} (header.sid=${sid ?? "(none)"}, store.sid=${storeSid}): ${parsed.error.issues[0]?.message}`);
      return c.json(formatZodIssues(parsed.error), 400);
    }
    const { status, feedback } = parsed.data;

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
      "ui_reject_button";
    log(
      `[status] header.sid=${sid ?? "(none)"} store.sid=${storeSid} artifactId=${artifactId} ` +
      `targetFound=${!!target} fromStatus=${target?.status ?? "(missing)"} toStatus=${status} reason=${reason}`,
    );

    await store.updateArtifactStatus(artifactId, status, reason as any);
    await store.resolvePlanReview(artifactId, status, feedback);
    // X6 — see comment above; HTTP-side mutations pass null for `server`.
    await maybeUpdateTaskStatus(null, artifactId, store);

    // U0.6 — force the debounced flush so the Stop hook (which reads
    // .deeppairing/sessions/*/artifacts.json directly from disk) sees the
    // new status before its next tick. Without this, a 100ms debounce window
    // can mean the hook reads stale `draft` and traps the agent in a poll
    // loop even though the user just approved.
    // AA7b — forceFlush is required on IStore, no cast needed.
    await store.forceFlush();

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
        // AA1 — when the artifact's content carries a Y5-style concept
        // (code_change does today; spec/plan can in the future), use its
        // name as the cross-project ledger key. Otherwise fall back to
        // the artifact title.
        const artConcept: string | undefined = (artifact.content as any)?.concept?.name;
        await store.recordRejectedApproach({
          description: artifact.title,
          reason: feedback?.trim() || undefined,
          sourceArtifactId: artifactId,
          concept: artConcept,
        });
        broadcast({
          type: "ledger_write",
          kind: "rejected",
          description: artifact.title,
          concept: artConcept,
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
    const parsed = RenameBodySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    const title = parsed.data.title.trim();
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
    const entries = getGlobalStore().query({
      stance: stance && ["avoid", "prefer", "mixed"].includes(stance) ? stance : undefined,
      concept,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50,
    });
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
      return c.json({ error: "invalid JSON body", code: "validation_error" }, 400);
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
          code: "validation_error",
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
          code: "validation_error",
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
        { error: "concept is required (paste a rule, idea, or pattern name)", code: "validation_error" },
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

  app.get("/api/philosophy/digest", (c) => {
    const sinceDays = Math.min(Math.max(Number(c.req.query("sinceDays") ?? 7), 1), 90);
    const now = Date.now();
    const fromMs = now - sinceDays * 24 * 60 * 60 * 1000;
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(now).toISOString();

    // Pull a wide slice — the digest computes its own breakdowns.
    const entries = getGlobalStore().query({ limit: 500 });

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
    const project = FileStore.ledgerDigest(projectRoot);
    const entries = getGlobalStore().query({ limit: 10000 });
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
    const raw = await c.req.json().catch(() => null);
    const parsed = RetrospectiveBodySchema.safeParse(raw);
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
    const parsed = PreferenceBodySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    if (parsed.data.autonomyLevel) {
      await store.setAutonomyLevel(parsed.data.autonomyLevel);
      broadcast({ type: "preference_changed", autonomyLevel: parsed.data.autonomyLevel }, sid);
    }
    return c.json({ status: "updated" });
  });

  // Read a project file for the FileViewer
  app.get("/api/files", (c) => {
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
    const body = await c.req.json();
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
  app.post("/api/prompts", async (c) => {
    if (!projectRoot) return c.json({ error: "No project root" }, 500);
    const body = await c.req.json();
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
