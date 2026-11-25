import path from "node:path";
import { safeLintPage, formatPageLintWarnings } from "../mcp/page-lint.js";
import { ArtifactStatusSchema, PageContentSchema, PreflightTraceSchema, type Artifact } from "@deeppairing/shared";
import { z } from "zod";
import { ERROR_CODES, TOOL_ERROR_CODES, type ErrorCode } from "../error-codes.js";
import { preflightRejectedApproaches } from "../mcp/tool-helpers.js";
import { handleReviseArtifact, revisionNote } from "../mcp/tools/revise-artifact.js";
import type { BroadcastFn, ToolResult } from "../mcp/tools/types.js";
import { writeJsonAtomic } from "../store/atomic-write.js";
import { withFileLock } from "../store/file-lock.js";
import type { FileStore } from "../store/file-store.js";
import { PageRevisionFeedbackConflictError, pageRevisionFeedbackProofSchema, provePageRevisionFeedback, type PageRevisionFeedbackRefusal } from "../store/page-revision-feedback.js";
import { findPageSuccessor } from "./page-successor.js";
import {
  operationDigest, readJsonFile, readSessionRecord, receiptDigestSchema,
  standaloneOperationConflict, standaloneOperationKey,
  type StandaloneCloseoutSnapshot,
} from "./standalone-receipts.js";

const receiptSchema = z.object({
  version: z.literal(1),
  fingerprint: receiptDigestSchema,
  childDigest: receiptDigestSchema.optional(),
  parentStatus: ArtifactStatusSchema.optional(),
  parentHistoryLength: z.number().int().nonnegative().optional(),
  trace: PreflightTraceSchema.optional(),
  feedback: pageRevisionFeedbackProofSchema.optional(),
  committed: z.literal(true).optional(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;

function refused(message: string, code: ErrorCode, details: Record<string, unknown> = {}) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }], structuredContent: { code, ...details } };
}

function childDigest(child: { version?: unknown; parentId?: unknown; content?: unknown; agentReasoning?: unknown }): string {
  return operationDigest([child.version, child.parentId, child.content, child.agentReasoning]);
}

function revisionOperation(
  projectRoot: string,
  store: FileStore,
  operationId: string,
  broadcast: BroadcastFn,
) {
  const sessionId = store.getSessionId();
  const dir = path.join(projectRoot, ".deeppairing", "sessions", sessionId);
  const receiptPath = path.join(dir, `revise-page-${operationId}.json`);
  const key = standaloneOperationKey(projectRoot, sessionId, "revise_page", operationId);
  const artifactId = `art_${key}`;
  const commentId = `cmt_${key}`;
  const save = (receipt: Receipt) => writeJsonAtomic(receiptPath, receipt, 2, { mode: 0o600 });
  const lock = <T>(run: () => T) => withFileLock(path.join(dir, ".standalone-revise-page.lock"), run);
  const read = () => receiptSchema.parse(readJsonFile(receiptPath));

  function target(parentId: string) {
    const artifacts = store.getArtifacts();
    const parent = artifacts.find((a) => a.id === parentId && a.type === "page" && a.sessionId === sessionId);
    if (!parent) return refused(`No page ${parentId} exists in this standalone session.`, ERROR_CODES.artifact_not_in_session);
    const successor = findPageSuccessor(parent, artifacts);
    if (successor) {
      return refused(`Page ${parentId} moved to v${successor.version} (${successor.id}). Read the newer version before revising.`,
        ERROR_CODES.parent_superseded, {
          currentArtifactId: successor.id, currentVersion: successor.version, currentStatus: successor.status,
        });
    }
    if (["superseded", "retracted", "rejected", "obsolete"].includes(parent.status)) {
      return refused(`Page ${parentId} is ${parent.status} and cannot be revised.`, ERROR_CODES.validation_error);
    }
    // Earlier MCP revisions can store only HTML, with the title on the card.
    const content = PageContentSchema.safeParse({ ...parent.content, title: parent.title });
    if (!content.success || content.data.sourcePath !== undefined) {
      return refused(`Page ${parentId} must be an inline page. To revise a file-backed page, save changes to its source file.`,
        ERROR_CODES.validation_error);
    }
    const { title, summary, concept } = content.data;
    return { status: parent.status, historyLength: parent.statusHistory?.length ?? 0, metadata: { title, summary, concept } };
  }

  function requireChild(child: Record<string, unknown> | Artifact, receipt: Receipt, parentId: string): void {
    if (child.type !== "page" || child.sessionId !== sessionId || child.parentId !== parentId ||
      !receipt.childDigest || childDigest(child) !== receipt.childDigest) {
      throw new Error("Standalone revision child does not match its receipt.");
    }
  }

  function recover(receipt: Receipt, replayed: boolean, input: { parentId: string; reason: string; ackCommentIds: string[] },
    snapshot?: StandaloneCloseoutSnapshot): ToolResult | null {
    const { parentId, reason, ackCommentIds } = input;
    const note = revisionNote(artifactId, reason);
    function requireNote(comment: Record<string, unknown>): void {
      const target = comment.target as { artifactId?: unknown } | undefined;
      if (comment.author !== "agent" || comment.sessionId !== sessionId || target?.artifactId !== parentId ||
        comment.content !== note) {
        throw new Error("Standalone revision note does not match its receipt.");
      }
    }
    const record = snapshot?.record ?? ((file: string, key: string, id: string) => readSessionRecord(dir, file, key, id));
    const child = snapshot ? snapshot.artifact(artifactId) : store.getArtifacts().find((a) => a.id === artifactId);
    const diskChild = record("artifacts.json", "id", artifactId);
    const diskNote = record("comments.json", "id", commentId);
    const bufferedNote = snapshot ? snapshot.comment(commentId) : store.getComment(commentId);
    if (!child) {
      if (receipt.committed || diskChild || diskNote || bufferedNote) {
        throw new Error("Standalone revision has inconsistent durable records.");
      }
      return null;
    }
    requireChild(child, receipt, parentId);
    const { feedback } = receipt;
    if (JSON.stringify(feedback?.commentIds ?? []) !== JSON.stringify(ackCommentIds)) {
      throw new Error("Standalone revision is missing its exact feedback selection.");
    }
    const { trace } = receipt;
    if (trace?.decision !== "admitted" || trace.artifactId !== artifactId || trace.toolName !== "revise_artifact") {
      throw new Error("Standalone revision is missing its admitted preflight trace.");
    }
    const diskTrace = snapshot ? snapshot.trace(artifactId) : store.getPreflightTrace(artifactId);
    if (diskTrace && operationDigest(diskTrace) !== operationDigest(trace)) {
      throw new Error("Standalone revision preflight trace does not match its receipt.");
    }
    if (diskChild) requireChild(diskChild, receipt, parentId);
    if (diskNote) requireNote(diskNote);
    if (bufferedNote) requireNote({ ...bufferedNote });

    const parent = snapshot ? snapshot.artifact(parentId) : store.getArtifacts().find((a) => a.id === parentId);
    const hasOtherChild = snapshot ? snapshot.hasOtherChild(parentId, artifactId) :
      store.getArtifacts().some((a) => a.parentId === parentId && a.id !== artifactId);
    if (!parent || parent.sessionId !== sessionId || parent.type !== "page" || parent.version + 1 !== child.version || hasOtherChild) {
      throw new Error("Standalone revision has inconsistent page lineage.");
    }
    const requireDurableVersion = (durableParent: Record<string, unknown> | Artifact | undefined,
      durableChild: Record<string, unknown> | Artifact | undefined, requireSuperseded = !receipt.committed) => {
      if (durableChild?.id !== artifactId || durableParent?.sessionId !== sessionId || durableParent.type !== "page" ||
        durableParent.version !== child.version - 1 || (requireSuperseded && durableParent.status !== "superseded")) {
        throw new Error("Standalone revision is missing its durable page version.");
      }
      requireChild(durableChild, receipt, parentId);
    };
    const checkVersion = (requireSuperseded?: boolean) => requireDurableVersion(
      record("artifacts.json", "id", parentId),
      record("artifacts.json", "parentId", parentId),
      requireSuperseded,
    );
    const flush = () => feedback ? store.forceFlush({ parentId, proof: feedback }) : store.forceFlush();
    if (!receipt.committed) {
      if (parent.status !== "superseded") {
        const expectedStatus = receipt.parentStatus;
        const statusChanged = expectedStatus === undefined
          ? !["draft", "reviewing"].includes(parent.status)
          : parent.status !== expectedStatus;
        const verdictChanged = receipt.parentHistoryLength !== undefined &&
          (parent.statusHistory?.length ?? 0) !== receipt.parentHistoryLength;
        if (statusChanged || verdictChanged) {
          throw new Error("Standalone revision cannot recover after the predecessor's review state changed.");
        }
      }
      if (snapshot) {
        checkVersion(false);
        if (feedback) snapshot.verifyFeedback(parentId, feedback);
        return { content: [] };
      }
      if (parent.status !== "superseded") store.updateArtifactStatus(parentId, "superseded", "agent_supersede");
      // The comments file can flush even when artifact persistence fails.
      // Stage the revision note only after verifying both durable versions.
      flush();
      checkVersion();
      if (!diskNote) {
        if (!bufferedNote) store.addComment({ id: commentId, artifactId: parentId, content: note, author: "agent" });
        flush();
        const savedNote = readSessionRecord(dir, "comments.json", "id", commentId);
        if (!savedNote) throw new Error("Standalone revision is missing its durable note.");
        requireNote(savedNote);
      }
      if (!diskTrace) store.recordPreflightTrace(artifactId, trace);
      const savedTrace = store.getPreflightTrace(artifactId);
      const comment = store.getComment(commentId);
      if (!savedTrace || operationDigest(savedTrace) !== operationDigest(trace) || !comment) {
        throw new Error("Standalone revision is missing its durable note or preflight trace.");
      }
      const acknowledged = feedback ? store.acknowledgePageRevisionFeedback(parentId, feedback, (rows) => {
        const successors = rows.filter((row) => row.parentId === parentId);
        requireDurableVersion(rows.find((row) => row.id === parentId), successors.length === 1 ? successors[0] : undefined);
      }) : [];
      save({ ...receipt, committed: true });
      broadcast({ type: "artifact_created", artifact: child });
      broadcast({ type: "artifact_updated", artifactId: parentId, status: "superseded" });
      broadcast({ type: "comment_added", comment });
      broadcast({ type: "preflight_trace_recorded", artifactId, trace });
      for (const row of acknowledged) broadcast({ type: "comment_updated", comment: row });
    } else {
      checkVersion();
      if (!diskNote) throw new Error("Standalone revision is missing its durable note.");
      if (!diskTrace) throw new Error("Standalone revision is missing its durable preflight trace.");
      if (snapshot) return { content: [] };
    }

    const latest = findPageSuccessor(child, store.getArtifacts());
    return {
      content: [{ type: "text", text: `Page ${parentId} was revised as ${artifactId} (v${child.version}).` }],
      structuredContent: {
        sessionId, parentArtifactId: parentId, artifactId, version: child.version, status: child.status,
        ...(feedback ? { acknowledgedCommentIds: feedback.commentIds } : {}),
        ...(feedback?.includesRuleOut ? { acknowledgementNote: "Acknowledgement leaves the rule-out status unchanged." } : {}),
        ...(replayed ? { replayed: true } : {}),
        ...(latest ? { currentArtifactId: latest.id, currentVersion: latest.version, currentStatus: latest.status } : {}),
      },
    };
  }

  function reconcile(snapshot?: StandaloneCloseoutSnapshot): boolean {
    const receipt = read();
    const record = snapshot?.record ?? ((file: string, key: string, id: string) => readSessionRecord(dir, file, key, id));
    const child = record("artifacts.json", "id", artifactId);
    if (!child) {
      const buffered = snapshot ? snapshot.artifact(artifactId) : store.getArtifacts().find((row) => row.id === artifactId);
      const note = snapshot ? snapshot.comment(commentId) : store.getComment(commentId);
      const trace = snapshot ? snapshot.trace(artifactId) : store.getPreflightTrace(artifactId);
      if (receipt.committed || buffered || note || record("comments.json", "id", commentId) || trace) {
        throw new Error("Standalone revision has effects without a durable successor.");
      }
      return false;
    }
    if (typeof child.parentId !== "string" || typeof child.agentReasoning !== "string" || !child.agentReasoning.trim()) {
      throw new Error("Standalone revision is missing its durable parent or revision reason.");
    }
    requireChild(child, receipt, child.parentId);
    const content = PageContentSchema.parse(child.content);
    const ackCommentIds = receipt.feedback?.commentIds ?? [];
    const fingerprint = operationDigest({
      artifactId: child.parentId, reason: child.agentReasoning, html: content.html,
      ...(ackCommentIds.length ? { ackCommentIds } : {}),
    });
    if (receipt.fingerprint !== fingerprint) throw new Error("Standalone revision child does not match its request fingerprint.");
    if (!receipt.committed) {
      const parent = record("artifacts.json", "id", child.parentId);
      const expectedHistory = receipt.parentHistoryLength;
      const observedHistory = Array.isArray(parent?.statusHistory) ? parent.statusHistory.length : 0;
      const expectedStatus = receipt.parentStatus;
      if (!parent || parent.type !== "page" || parent.sessionId !== sessionId ||
        (parent.status !== "superseded" && (
          (expectedStatus === undefined ? parent.status !== "draft" && parent.status !== "reviewing" : parent.status !== expectedStatus) ||
          (expectedHistory !== undefined && expectedHistory !== observedHistory)
        ))) {
        throw new Error("Standalone revision cannot recover after the durable predecessor's review state changed.");
      }
    }
    recover(receipt, true, { parentId: child.parentId, reason: child.agentReasoning, ackCommentIds }, snapshot);
    return !receipt.committed;
  }

  return { artifactId, receiptPath, save, lock, read, target, recover, reconcile };
}

/** Settle a verified revision from its durable child and prepared receipt. */
export function planStandalonePageRevisionRecovery(projectRoot: string, store: FileStore, operationId: string,
  broadcast: BroadcastFn, snapshot: StandaloneCloseoutSnapshot): (() => void) | undefined {
  const operation = revisionOperation(projectRoot, store, operationId, broadcast);
  if (!operation.reconcile(snapshot)) return;
  return () => { operation.lock(operation.reconcile); };
}

export async function reviseStandalonePage(
  projectRoot: string,
  store: FileStore,
  operationId: string,
  input: { artifactId: string; html: string; reason: string; ackCommentIds?: string[] },
  broadcast: BroadcastFn,
): Promise<ToolResult> {
  const sessionId = store.getSessionId();
  const { artifactId: parentId, reason, html } = input;
  const ackCommentIds = [...(input.ackCommentIds ?? [])].sort();
  const fingerprint = operationDigest({ artifactId: parentId, reason, html, ...(ackCommentIds.length ? { ackCommentIds } : {}) });
  const { artifactId, receiptPath, save, lock, read, target: findTarget, recover: recoverOperation } =
    revisionOperation(projectRoot, store, operationId, broadcast);
  const target = () => findTarget(parentId);
  const recover = (receipt: Receipt, replayed: boolean) => recoverOperation(receipt, replayed, { parentId, reason, ackCommentIds });
  const existing = lock(() => {
    const saved = readJsonFile(receiptPath);
    if (saved !== undefined) {
      const receipt = receiptSchema.parse(saved);
      if (receipt.fingerprint !== fingerprint) return standaloneOperationConflict("revision input");
      const replay = recover(receipt, true);
      if (replay) return replay;
    } else save({ version: 1, fingerprint });
    return null;
  });
  if (existing) return existing;
  const parent = target();
  if ("isError" in parent) return parent;
  const metadataDigest = operationDigest(parent.metadata);
  const proveFeedback = (onRefusal?: (refusal: PageRevisionFeedbackRefusal) => void) =>
    provePageRevisionFeedback(store.getArtifacts(), store.getComments(), sessionId, parentId, ackCommentIds, undefined, onRefusal);
  const selection: { refusal?: PageRevisionFeedbackRefusal } = {};
  const feedback = ackCommentIds.length ? proveFeedback((failure) => { selection.refusal = failure; }) : undefined;
  if (ackCommentIds.length && !feedback) {
    const { refusal: selectionRefusal } = selection;
    if (!selectionRefusal) {
      return refused("The selected feedback could not be verified against this page's history.", ERROR_CODES.validation_error);
    }
    const id = JSON.stringify(selectionRefusal.id);
    const message = selectionRefusal?.kind === "question"
      ? `Comment ${id} is a question. Answer it in the revised page and leave it out of --ack-comment-id so it stays pending until handled.`
      : selectionRefusal?.kind === "suggestion"
        ? `Comment ${id} is a suggestion. Use its separate review flow and leave it out of --ack-comment-id.`
        : `Comment ${id} is ineligible. Supply an ordinary anchored human comment ID from this page or a direct ancestor.`;
    return refused(message, ERROR_CODES.validation_error);
  }

  let blockReason: string | undefined;
  const result = await handleReviseArtifact({
    store, broadcast,
    helpers: {
      preflightRejectedApproaches: async (...args) => {
        const preflight = await preflightRejectedApproaches(store, broadcast, ...args);
        if (!preflight.ok && typeof preflight.event.match.reason === "string") blockReason = preflight.event.match.reason;
        return preflight;
      },
    },
    standalonePage: {
      artifactId,
      persist: (params, trace) => lock(() => {
        const receipt = read();
        if (receipt.fingerprint !== fingerprint) return standaloneOperationConflict("revision input");
        const replay = recover(receipt, true);
        if (replay) return replay;
        const current = target();
        if ("isError" in current) return current;
        if (operationDigest(current.metadata) !== metadataDigest) {
          return refused(`Page ${parentId}'s metadata changed during review. Read it before retrying the revision.`,
            ERROR_CODES.session_review_conflict);
        }
        if (feedback && (proveFeedback()?.digest !== feedback.digest ||
          (receipt.feedback && receipt.feedback.digest !== feedback.digest))) {
          return refused("The selected page feedback changed during review. Read it before retrying the revision.",
            ERROR_CODES.session_review_conflict);
        }
        const prepared = {
          ...receipt,
          childDigest: childDigest(params),
          parentStatus: current.status,
          parentHistoryLength: current.historyLength,
          trace,
          ...(feedback ? { feedback } : {}),
        };
        const create = () => {
          save(prepared);
          store.createArtifact(params);
        };
        if (feedback) {
          // Prove raw durable and newly buffered comments under the session
          // lock before any ordinary flush could normalize corrupt input.
          try {
            store.preparePageRevisionFeedback(parentId, feedback, (durableParent) => {
              const parsed = PageContentSchema.safeParse({ ...durableParent.content, title: durableParent.title });
              const live = target();
              if ("isError" in live || !parsed.success || parsed.data.sourcePath !== undefined ||
                durableParent.status !== current.status || (durableParent.statusHistory?.length ?? 0) !== current.historyLength ||
                operationDigest(live.metadata) !== metadataDigest) {
                throw new PageRevisionFeedbackConflictError("Page revision predecessor changed during review.");
              }
              const { title, summary, concept } = parsed.data;
              if (operationDigest({ title, summary, concept }) !== metadataDigest) {
                throw new PageRevisionFeedbackConflictError("Page revision predecessor metadata changed during review.");
              }
              create();
            });
          } catch (error) {
            if (error instanceof PageRevisionFeedbackConflictError) {
              return refused(error.message, ERROR_CODES.session_review_conflict);
            }
            throw error;
          }
        } else create();
        const committed = recover(prepared, false);
        if (!committed) throw new Error("Standalone revision could not confirm page creation.");
        return committed;
      }),
    },
  }, { artifactId: parentId, mode: "supersede", reason, title: parent.metadata.title, content: { ...parent.metadata, html } });

  if (result.isError && result.structuredContent === undefined) {
    // An identical concurrent operation may have committed before this
    // invocation reached the handler's closed-parent check.
    const replay = lock(() => {
      const receipt = read();
      return receipt.fingerprint === fingerprint ? recover(receipt, true) : standaloneOperationConflict("revision input");
    });
    if (replay) return replay;
    if (result._meta?.code === TOOL_ERROR_CODES.REJECTED_APPROACH_BLOCKED) {
      return { ...result, structuredContent: { code: ERROR_CODES.rejected_approach_blocked, reason: blockReason } };
    }
    const parent = target();
    if ("isError" in parent) return parent;
  }
  // #714 gap 6 — the same non-blocking authoring lint as present page, on a
  // fresh revision only (a replay returns the stored receipt as it was).
  if (!result.isError && result.structuredContent?.replayed !== true) {
    const warnings = safeLintPage(html);
    if (warnings.length > 0) {
      return {
        ...result,
        content: result.content.map((c, i) => (i === 0 && c.type === "text" ? { ...c, text: c.text + formatPageLintWarnings(warnings) } : c)),
        structuredContent: { ...result.structuredContent, warnings },
      };
    }
  }
  return result;
}
