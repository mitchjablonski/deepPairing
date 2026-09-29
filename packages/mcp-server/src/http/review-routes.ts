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

export function createReviewRoutes({
  getStore,
  broadcast,
  log,
  updateTaskStatus,
}: ReviewRoutesDeps) {
  const app = new Hono();

  // Resolve a decision from the web UI.
  app.post("/api/decisions/:decisionId", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    const decisionId = c.req.param("decisionId");
    const bodyVal = await readJsonValue(c);
    if (!bodyVal.ok) return bodyVal.res;
    const parsed = DecisionResolveBodySchema.safeParse(bodyVal.value);
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    const { optionId, reasoning } = parsed.data;

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

    await store.resolveDecision(decisionId, optionId, reasoning);
    const decision = await store.getDecision(decisionId);
    if (decision && (await store.getDecisionResponse(decisionId))?.optionId !== optionId) {
      return c.json(
        { error: `optionId "${optionId}" is not an option of decision ${decisionId}`, code: ERROR_CODES.validation_error },
        400,
      );
    }

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
    if (targetArtifactId && !decision) {
      await store.updateArtifactStatus(targetArtifactId, "approved", "ui_decision_resolve");
    }

    await store.forceFlush();
    if (targetArtifactId) await updateTaskStatus(targetArtifactId, store);

    broadcast({
      type: "decision_resolved",
      decisionId,
      artifactId: targetArtifactId,
      optionId,
      reasoning,
    }, sid);

    return c.json({ status: "resolved", decisionId });
  });

  // Approve/revise/reject a plan from the web UI.
  app.post("/api/artifacts/:artifactId/status", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    const storeSid = store.getSessionId?.() ?? "(unknown)";
    const artifactId = c.req.param("artifactId");
    const bodyVal = await readJsonValue(c);
    if (!bodyVal.ok) return bodyVal.res;
    const parsed = StatusUpdateBodySchema.safeParse(bodyVal.value);
    if (!parsed.success) {
      log(`[status] REJECTED — body schema invalid for ${artifactId} (header.sid=${sid ?? "(none)"}, store.sid=${storeSid}): ${parsed.error.issues[0]?.message}`);
      return c.json(formatZodIssues(parsed.error), 400);
    }
    const { status, feedback, concept: humanConcept } = parsed.data;

    const artsBefore = await store.getArtifacts();
    const target = artsBefore.find((a) => a.id === artifactId);
    const reason =
      status === "approved" ? "ui_approve_button" :
      status === "revised" ? "ui_revise_button" :
      status === "obsolete" ? "ui_dismiss_obsolete" :
      "ui_reject_button";
    log(
      `[status] header.sid=${sid ?? "(none)"} store.sid=${storeSid} artifactId=${artifactId} ` +
      `targetFound=${!!target} fromStatus=${target?.status ?? "(missing)"} toStatus=${status} reason=${reason}`,
    );

    if (!target) {
      return c.json(
        { error: "artifact_not_in_session", code: "artifact_not_in_session",
          message: "This artifact belongs to a different session than the one this tab is bound to." },
        404,
      );
    }

    if (isCrossTerminalVerdictFlip(target.status, status, reason)) {
      const at = target.updatedAt;
      log(
        `[status] REFUSED cross-tab verdict flip on ${artifactId}: ` +
        `${target.status} → ${status} (reason=${reason}) — verdict already final at ${at}`,
      );
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

    let rejection: { description: string; reason?: string; sourceArtifactId: string; concept?: string } | null = null;
    if (status === "rejected") {
      const artifact = target;
      if (artifact && LEDGER_EXEMPT_REJECT_TYPES.has(artifact.type)) {
        // Status flip only; comprehension artifacts do not carry taste stance.
      } else if (artifact && artifact.type !== "decision") {
        const artConcept = (artifact.content as { concept?: { name?: string } })?.concept?.name;
        const changesetFallback =
          artifact.type === "changeset" ? stripLeadingPathToken(artifact.title) : undefined;
        const concept = humanConcept?.trim() || artConcept || changesetFallback || undefined;
        rejection = { description: artifact.title, reason: feedback?.trim() || undefined, sourceArtifactId: artifactId, concept };
      } else if (artifact && artifact.type === "decision") {
        const content = artifact.content as { context?: string; title?: string } | null;
        const context = content?.context?.trim() || artifact.title;
        const concept = humanConcept?.trim() || content?.title?.trim() || context || undefined;
        rejection = { description: artifact.title, reason: feedback?.trim() || undefined, sourceArtifactId: artifactId, concept };
      }
    }

    let retractOnConflict: string | null = null;
    let recordAfterFlush = false;
    if (rejection && await store.previewReviewConflict?.(artifactId, status)) {
      recordAfterFlush = true;
    } else if (rejection) {
      const had = (await store.getSessionMemory()).rejectedApproaches
        .some((r) => r.description === rejection!.description);
      await store.recordRejectedApproach(rejection);
      if (!had) retractOnConflict = rejection.description;
    }

    await store.updateArtifactStatus(artifactId, status, reason);
    if (status !== "obsolete") {
      await store.resolvePlanReview(artifactId, status, feedback);
    }
    await updateTaskStatus(artifactId, store);

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

    try {
      await store.forceFlush();
    } catch (err) {
      if (isSessionReviewConflictError(err)) {
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

  app.post("/api/artifacts/:artifactId/changeset-review", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    if (!store) return c.json(NO_SESSION_RESPONSE, 409);
    const artifactId = c.req.param("artifactId");
    const bodyVal = await readJsonValue(c);
    if (!bodyVal.ok) return bodyVal.res;
    const parsed = ChangesetReviewBodySchema.safeParse(bodyVal.value);
    if (!parsed.success) return c.json(formatZodIssues(parsed.error), 400);
    const { filePath, state, reason } = parsed.data;

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
      return c.json(
        { error: "not_a_changeset_file", code: "not_a_changeset_file",
          message: "That artifact is not a changeset, or the file path is not part of it." },
        400,
      );
    }
    await store.forceFlush();
    broadcast({ type: "changeset_review_updated", artifact: updated }, sid);
    return c.json({ status: "updated", artifactId });
  });

  return app;
}
