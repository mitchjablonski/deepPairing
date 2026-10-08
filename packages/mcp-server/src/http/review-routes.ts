import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Artifact } from "@deeppairing/shared";
import {
  ChangesetReviewBodySchema,
  DecisionResolveBodySchema,
  StatusUpdateBodySchema,
  formatZodIssues,
} from "@deeppairing/shared";
import { ERROR_CODES } from "../error-codes.js";
import { LEDGER_EXEMPT_REJECT_TYPES } from "../store/file-store.js";
import { isSessionReviewConflictError } from "../store/session-records.js";
import type { IStore } from "../store/store-interface.js";
import { stripLeadingPathToken } from "../store/concept-hygiene.js";
import { isCrossTerminalVerdictFlip } from "../store/verdict-guard.js";
import { checkStaleResolve } from "../store/decision-resolve-guard.js";
import { getSessionId, NO_SESSION_RESPONSE, readJsonValue } from "./route-helpers.js";

/** The persistence surface required by current-session review mutations. */
export type ReviewStore = Pick<
  IStore,
  | "addComment"
  | "forceFlush"
  | "getArtifacts"
  | "getDecision"
  | "getDecisionResponse"
  | "getSessionId"
  | "getSessionMemory"
  | "previewReviewConflict"
  | "recordRejectedApproach"
  | "resolveDecision"
  | "resolvePlanReview"
  | "retractRejectedApproach"
  | "setChangesetFileReview"
  | "updateArtifactStatus"
>;

type StoreGetter = (sessionId?: string) => ReviewStore | null;
type BroadcastFn = (event: unknown, sessionId?: string) => void;
type LogFn = (msg: string) => void;
type TaskStatusFn = (artifactId: string, store: ReviewStore) => Promise<void> | void;

export interface ReviewRoutesDeps {
  getStore: StoreGetter;
  broadcast: BroadcastFn;
  log: LogFn;
  updateTaskStatus: TaskStatusFn;
}

/**
 * Mount through createHttpRoutes: this router inherits the parent's onError
 * mappings for ELOCKED -> 503 lock_busy and review conflicts -> 409
 * session_review_conflict. A standalone router has Hono's default 500 handler.
 * Keep that error policy on the parent alongside the shared middleware.
 */
export function createReviewRoutes({
  getStore,
  broadcast,
  log,
  updateTaskStatus,
}: ReviewRoutesDeps) {
  const app = new Hono();

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
    const { optionId, reasoning } = parsed.data;

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

    // #460 / #464 review — refuse a stale card BEFORE any write (shared with
    // the internal resolve route): a different pick, or a pick on a decision
    // closed elsewhere, is a 409 carrying the recorded resolution; the same
    // pick again is a true no-op 200 (nothing rewritten). See
    // store/decision-resolve-guard.ts.
    {
      const stale = await checkStaleResolve(store, decisionId, optionId);
      if (stale?.kind === "same") return c.json(stale.body);
      if (stale?.kind === "conflict") {
        log(`[decision] REFUSED stale resolve on ${decisionId}: ${String(stale.body.message)}`);
        if (stale.backing) broadcast({ type: "artifact_updated", artifactId: stale.backing.id, status: stale.backing.status }, sid);
        return c.json(stale.body, 409);
      }
    }

    // #197 (F3) — prediction capture was cut (E3); the UI no longer sends it and
    // this write path no longer accepts it. The store method keeps its optional
    // `prediction` param for backward-compatible reads of old records.
    await store.resolveDecision(decisionId, optionId, reasoning);

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
    // #209 (J1) — when a decision RECORD exists, store.resolveDecision ALREADY
    // advanced its backing artifact to `approved` atomically (single flush, no
    // resolved-but-draft window). Re-flipping here would append a SPURIOUS
    // duplicate statusHistory entry, so the explicit flip is now scoped to the
    // no-record FALLBACK only: the daemon's decisions map can lag/miss a record
    // the artifact already carries (X6), and in that case the store had nothing
    // to advance — so the route is the belt that still leaves the artifact honest.
    let targetArtifactId = decision?.artifactId;
    let fallbackArtifact: Artifact | undefined;
    if (!targetArtifactId) {
      const artifacts = await store.getArtifacts();
      fallbackArtifact = artifacts.find(
        (a) =>
          a.type === "decision" &&
          ((a.content as { decisionId?: string } | null)?.decisionId === decisionId || a.id === decisionId),
      );
      targetArtifactId = fallbackArtifact?.id;
    }
    // P3 — the no-record fallback's SILENT SUCCESS. updateArtifactStatus carries
    // the O3 verdict guard as a store-authoritative backstop: on an artifact
    // already at a DIFFERENT terminal verdict (rejected/revised — e.g. a stale
    // tab still showing the option list after the human rejected the whole
    // framing in another tab) it logs and `return`s without writing, while this
    // route went on to broadcast `decision_resolved` and answer 200
    // {status:"resolved"} — reporting a resolution that never landed. Pre-check
    // the same predicate the verdict route uses and answer 409
    // verdict_already_final instead, re-broadcasting the REAL status so the
    // stale tab refreshes. Only the fallback branch needs this: with a record,
    // store.resolveDecision owns the (identically guarded) advance and this
    // route writes no status at all.
    if (targetArtifactId && !decision && fallbackArtifact) {
      if (isCrossTerminalVerdictFlip(fallbackArtifact.status, "approved", "ui_decision_resolve")) {
        const at = fallbackArtifact.updatedAt;
        log(
          `[decision] REFUSED resolve on ${targetArtifactId}: ` +
          `${fallbackArtifact.status} → approved (reason=ui_decision_resolve) — verdict already final at ${at}`,
        );
        broadcast({ type: "artifact_updated", artifactId: targetArtifactId, status: fallbackArtifact.status }, sid);
        return c.json(
          {
            error: "verdict_already_final",
            code: "verdict_already_final",
            currentStatus: fallbackArtifact.status,
            at,
            message:
              `This decision was already ${fallbackArtifact.status}${at ? ` at ${at}` : ""} in another tab. ` +
              `A finalized verdict can't be reversed — this tab has been refreshed to the current state.`,
          },
          409,
        );
      }
    }
    if (targetArtifactId) {
      if (!decision) {
        // No-record fallback only — store.resolveDecision couldn't advance the
        // artifact (it had no record to key off), so the route does it.
        await store.updateArtifactStatus(targetArtifactId, "approved", "ui_decision_resolve");
      }
    }

    // A decision response authorizes its backing artifact. Persist the
    // artifact and decision record together before announcing success; a
    // concurrent proposal rewrite must return the global typed 409 and emit no
    // decision_resolved event.
    await store.forceFlush();

    if (targetArtifactId) {
      // X6 — emission seam: HTTP-side mutations pass null for `server`
      // (the MCP server lives in the daemon's separate process). Today
      // a no-op; future Tasks impl can route via the daemon broadcast.
      await updateTaskStatus(targetArtifactId, store);
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

    // O3 (#231) — cross-tab last-wins verdict guard. A stale second tab (opened
    // before the verdict, still rendering the draft footer) can POST a DIFFERENT
    // terminal verdict onto an already-final one — silently reversing the human's
    // real decision. Refuse it with a 409 carrying the current truth, and
    // re-broadcast the REAL status so the stale tab refreshes to it (its footer
    // collapses to the passive verdict chip). Draft→terminal and same-verdict
    // re-asserts are unaffected; the store backstops this too. See verdict-guard.ts.
    if (isCrossTerminalVerdictFlip(target.status, status, reason)) {
      const at = target.updatedAt;
      log(
        `[status] REFUSED cross-tab verdict flip on ${artifactId}: ` +
        `${target.status} → ${status} (reason=${reason}) — verdict already final at ${at}`,
      );
      // Refresh the stale tab to the TRUE status (not the attempted one).
      broadcast({ type: "artifact_updated", artifactId, status: target.status }, sid);
      return c.json(
        {
          error: "verdict_already_final",
          code: "verdict_already_final",
          currentStatus: target.status,
          at,
          message:
            `This artifact was already ${target.status}${at ? ` at ${at}` : ""} in another tab. ` +
            `A finalized verdict can't be reversed — this tab has been refreshed to the current state.`,
        },
        409,
      );
    }

    // #408 review — RECORD FIRST, then commit the verdict. The rejected
    // approach is what makes the gate remember; recording it after the status
    // flip meant a busy preferences lock (ELOCKED → 503) left the artifact
    // `rejected` with no memory of it and no artifact_updated broadcast, while
    // the UI rolled its optimistic patch back. Now a lock failure throws here,
    // before anything is committed, and the route's onError answers 503
    // lock_busy — status, plan review and comment all stay unchanged, so the
    // UI rollback is the truth and a retry is clean. (recordRejectedApproach is
    // idempotent on description, so a retry never duplicates the row.)
    // When an artifact is rejected, remember the approach so pre-flight blocks
    // any future re-proposal. reason is the feedback comment (required
    // client-side).
    let rejection: { description: string; reason?: string; sourceArtifactId: string; concept?: string } | null = null;
    if (status === "rejected") {
      const artifact = target;
      // #193 E2 — the comprehension surfaces capture NO taste stance on reject
      // (see LEDGER_EXEMPT_REJECT_TYPES): an explainer teaches existing code, a
      // debrief accounts for finished work — neither proposes an approach. The
      // plain `rejected` status still lands below; here we skip BOTH the
      // ledger write and its `ledger_write` broadcast so nothing misreports a
      // stance being remembered. recordRejectedApproach guards this
      // authoritatively too — this is the belt to its suspenders.
      if (artifact && LEDGER_EXEMPT_REJECT_TYPES.has(artifact.type)) {
        // no-op — status flip only, no cross-project stance
      } else if (artifact && artifact.type !== "decision") {
        // The cross-project ledger key, in priority order:
        //   1. the HUMAN-named concept from the reject prompt (the whole point
        //      — the user phrases the pattern they're rejecting, so a future
        //      paraphrase gets caught), then
        //   2. AA1 — the artifact's own Y5-style concept (code_change carries
        //      one today; spec/plan may in future), then
        //   3. #171 — for a changeset, the changeset TITLE (it carries no
        //      top-level concept). This records exactly ONE framing entry —
        //      NO per-file fan-out, the exact over-block class #195's review
        //      killed; demo isolation is inherited via recordRejectedApproach.
        const artConcept = (artifact.content as { concept?: { name?: string } })?.concept?.name;
        // Q2 review H2 — the changeset fallback is the ONE key here that no
        // human ever authored: agents title changesets after the file they
        // touch, so this used to publish "packages/api/src/auth/
        // session-store.ts — swap Redis for a Map" verbatim into the shared
        // ledger, from a UI promising no file paths leave the project. Strip
        // the machine-generated path prefix (see concept-hygiene.ts for why
        // this cannot cost recall — a path-laden key could never match another
        // project's proposal in the first place). Applied ONLY here: a concept
        // the human typed, or one the agent named via Y5, is kept verbatim.
        const changesetFallback =
          artifact.type === "changeset" ? stripLeadingPathToken(artifact.title) : undefined;
        const concept = humanConcept?.trim() || artConcept || changesetFallback || undefined;
        rejection = { description: artifact.title, reason: feedback?.trim() || undefined, sourceArtifactId: artifactId, concept };
      } else if (artifact && artifact.type === "decision") {
        // #169 (+F1) — a WHOLE-CARD decision rejection is the "wrong question /
        // don't do this at all" gesture: the human rejects the FRAMING, not the
        // individual options. So record ONE framing-level entry, NOT one per
        // option. Fanning out per option (an earlier cut) poisoned every
        // option's surface noun project-wide: rejecting "Which cache backend?"
        // (Redis/Memcached/…) then surface-blocked a Redis job-queue edit, a
        // docker `redis:` service, an `lru-cache` import — because the matcher
        // pulls the post-colon noun ("…: Redis" → "redis") and matches it
        // everywhere. Keying on the QUESTION instead means the concept lane
        // catches a re-proposal of the same framing ("cache backend") while an
        // unrelated Redis edit sails through. The per-option-with-a-pick signal
        // still lives on the unchosen-losers path (check_feedback) and the
        // "none of these fit" send-back — both of which name specific options.
        //
        // Concept key priority mirrors the non-decision path: (1) the
        // HUMAN-named concept from the reject prompt (F3 — the whole point of
        // the field; earlier this branch discarded it), then (2) the card's
        // M1.1 SHORT title (the fork-naming question — a far tighter framing key
        // than the full-paragraph context), then (3) the context/question.
        // BACKCOMPAT: on a pre-M1 decision (no content.title) this collapses to
        // `humanConcept?.trim() || context || undefined` — byte-identical to
        // before, so no EXISTING ledger entry is re-keyed and the #195
        // one-framing-entry semantics are untouched.
        const content = artifact.content as { context?: string; title?: string } | null;
        const context = content?.context?.trim() || artifact.title;
        const concept = humanConcept?.trim() || content?.title?.trim() || context || undefined;
        rejection = { description: artifact.title, reason: feedback?.trim() || undefined, sourceArtifactId: artifactId, concept };
      }
    }
    // #408 review (M1) — the conflict check comes BEFORE recording: a verdict
    // that will 409 session_review_conflict must leave preferences untouched,
    // exactly as on main (which returned before recording). A predicted
    // conflict skips the record and falls through unchanged, so the flush
    // below still produces the 409 and keeps the human's feedback comment
    // durable, as before.
    let retractOnConflict: string | null = null;
    let recordAfterFlush = false;
    if (rejection && await store.previewReviewConflict?.(artifactId, status)) {
      recordAfterFlush = true; // predicted 409; if the flush unexpectedly succeeds, record then
    } else if (rejection) {
      const had = (await store.getSessionMemory()).rejectedApproaches
        .some((r) => r.description === rejection!.description);
      await store.recordRejectedApproach(rejection);
      if (!had) retractOnConflict = rejection.description;
    }

    await store.updateArtifactStatus(artifactId, status, reason);
    // "obsolete" is a dismissal, not a plan-review verdict — don't resolve a
    // plan review with it (and it narrows status to the three verdicts).
    if (status !== "obsolete") {
      await store.resolvePlanReview(artifactId, status, feedback);
    }
    // X6 — see comment above; HTTP-side mutations pass null for `server`.
    await updateTaskStatus(artifactId, store);

    // Preserve the human's explanation even if the artifact verdict races a
    // concurrent proposal rewrite. flush() keeps comments durable while it
    // rejects the unsafe artifact merge below, so the 409 is truthful about
    // the verdict without silently discarding the user's words.
    if (feedback) {
      const comment = await store.addComment({
        id: `cmt_${nanoid(10)}`,
        artifactId,
        content: feedback,
        author: "human",
        verdictFeedback: true,
      });
      broadcast({ type: "comment_added", comment }, sid);
    }

    // U0.6 — force the debounced flush so the Stop hook (which reads
    // .deeppairing/sessions/*/artifacts.json directly from disk) sees the
    // new status before its next tick. Without this, a 100ms debounce window
    // can mean the hook reads stale `draft` and traps the agent in a poll
    // loop even though the user just approved.
    // AA7b — forceFlush is required on IStore, no cast needed.
    // F10 review — ordinary disk failures remain log-and-retry because the
    // verdict already landed in memory. A review/content ownership conflict is
    // different: reporting success would authorize content this reviewer never
    // saw. Return 409 before any success broadcast; FileStore freezes its
    // authorization reads until the session is reloaded.
    try {
      await store.forceFlush();
    } catch (err) {
      if (isSessionReviewConflictError(err)) {
        // A concurrent rewrite landed in the ms between the preview and this
        // flush: undo the local rejection row this request added.
        if (retractOnConflict) {
          try { await store.retractRejectedApproach?.(retractOnConflict); }
          catch (retractErr) { console.error(`[deepPairing] could not retract rejection after a review conflict: ${retractErr}`); }
        }
        return c.json({
          error: "session_review_conflict",
          code: ERROR_CODES.session_review_conflict,
          message: err.message,
        }, 409);
      }
      console.error(`[deepPairing] verdict flush failed (verdict landed in memory; debounced flush will retry): ${err}`);
    }

    if (rejection && recordAfterFlush) await store.recordRejectedApproach(rejection);
    if (rejection) broadcast({ type: "ledger_write", kind: "rejected", ...rejection }, sid);
    broadcast({ type: "artifact_updated", artifactId, status }, sid);

    return c.json({ status: "updated", artifactId });
  });


  // #171/#175 — set ONE file's DISPOSITION: reviewed (looks right) or
  // needs_changes (flagged, with an optional reason), or clear it. This is
  // review PROGRESS persisted on the artifact content — NOT a decision record
  // (only approve/revise/reject write decisions). The whole-changeset action is
  // DERIVED in the UI from the dispositions (all reviewed → Approve; any flagged
  // → Send back the flagged files with their reasons).
  app.post("/api/artifacts/:artifactId/changeset-review", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    const artifactId = c.req.param("artifactId");
    // H2-2 (#145) — honest generic 400 on a malformed body; Zod field errors on
    // a valid-but-wrong-shape body.
    const bodyVal = await readJsonValue(c);
    if (!bodyVal.ok) return bodyVal.res;
    const parsed = ChangesetReviewBodySchema.safeParse(bodyVal.value);
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    const { filePath, state, reason } = parsed.data;

    // F6 — same cross-session guard as status/rename: a verdict on an artifact
    // this store doesn't own must FAIL LOUDLY (the UI rolls back its optimistic
    // flip), never report success for a write that didn't land.
    const target = (await store.getArtifacts()).find((a) => a.id === artifactId);
    if (!target) {
      return c.json(
        { error: "artifact_not_in_session", code: "artifact_not_in_session",
          message: "This artifact belongs to a different session than the one this tab is bound to." },
        404,
      );
    }
    if (!store.setChangesetFileReview) {
      return c.json({ error: "unsupported", code: "unsupported", message: "This store can't persist changeset review state." }, 409);
    }
    const updated = await store.setChangesetFileReview(artifactId, filePath, state, reason);
    if (!updated) {
      // Not a changeset, or the path isn't part of it — the caller's mistake,
      // surfaced honestly rather than a silent 200.
      return c.json(
        { error: "not_a_changeset_file", code: "not_a_changeset_file",
          message: "That artifact is not a changeset, or the file path is not part of it." },
        400,
      );
    }
    // Persist before reporting success. Review dispositions authorize the
    // changeset's file contents, so a concurrent proposal rewrite must surface
    // the global typed 409 and suppress the success broadcast.
    await store.forceFlush();
    // Full-artifact patch: review state lives in content, so the web store must
    // replaceArtifact (like plan_progress_updated), not just patch a status.
    broadcast({ type: "changeset_review_updated", artifact: updated }, sid);
    return c.json({ status: "updated", artifactId });
  });


  return app;
}
