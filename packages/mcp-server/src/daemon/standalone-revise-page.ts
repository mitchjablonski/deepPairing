import path from "node:path";
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

export async function reviseStandalonePage(
  projectRoot: string,
  store: FileStore,
  operationId: string,
  input: { artifactId: string; html: string; reason: string; ackCommentIds?: string[] },
  broadcast: BroadcastFn,
): Promise<ToolResult> {
  const sessionId = store.getSessionId();
  const { artifactId: parentId, reason, html } = input;
  const dir = path.join(projectRoot, ".deeppairing", "sessions", sessionId);
  const receiptPath = path.join(dir, `revise-page-${operationId}.json`);
  const ackCommentIds = [...(input.ackCommentIds ?? [])].sort();
  const fingerprint = operationDigest({ artifactId: parentId, reason, html, ...(ackCommentIds.length ? { ackCommentIds } : {}) });
  const key = standaloneOperationKey(projectRoot, sessionId, "revise_page", operationId);
  const artifactId = `art_${key}`;
  const commentId = `cmt_${key}`;
  const note = revisionNote(artifactId, reason);
  const save = (receipt: Receipt) => writeJsonAtomic(receiptPath, receipt, 2, { mode: 0o600 });
  const lock = <T>(run: () => T) => withFileLock(path.join(dir, ".standalone-revise-page.lock"), run);
  const read = () => receiptSchema.parse(readJsonFile(receiptPath));

  function target() {
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

  function requireChild(child: Record<string, unknown> | Artifact, receipt: Receipt): void {
    if (child.type !== "page" || child.sessionId !== sessionId || child.parentId !== parentId ||
      !receipt.childDigest || childDigest(child) !== receipt.childDigest) {
      throw new Error("Standalone revision child does not match its receipt.");
    }
  }

  function requireNote(comment: Record<string, unknown>): void {
    const target = comment.target as { artifactId?: unknown } | undefined;
    if (comment.author !== "agent" || comment.sessionId !== sessionId || target?.artifactId !== parentId ||
      comment.content !== note) {
      throw new Error("Standalone revision note does not match its receipt.");
    }
  }

  function recover(receipt: Receipt, replayed: boolean): ToolResult | null {
    const artifacts = store.getArtifacts();
    const child = artifacts.find((a) => a.id === artifactId);
    const diskChild = readSessionRecord(dir, "artifacts.json", "id", artifactId);
    const diskNote = readSessionRecord(dir, "comments.json", "id", commentId);
    const bufferedNote = store.getComment(commentId);
    if (!child) {
      if (receipt.committed || diskChild || diskNote || bufferedNote) {
        throw new Error("Standalone revision has inconsistent durable records.");
      }
      return null;
    }
    requireChild(child, receipt);
    const { feedback } = receipt;
    if (JSON.stringify(feedback?.commentIds ?? []) !== JSON.stringify(ackCommentIds)) {
      throw new Error("Standalone revision is missing its exact feedback selection.");
    }
    const { trace } = receipt;
    if (trace?.decision !== "admitted" || trace.artifactId !== artifactId || trace.toolName !== "revise_artifact") {
      throw new Error("Standalone revision is missing its admitted preflight trace.");
    }
    const diskTrace = store.getPreflightTrace(artifactId);
    if (diskTrace && operationDigest(diskTrace) !== operationDigest(trace)) {
      throw new Error("Standalone revision preflight trace does not match its receipt.");
    }
    if (diskChild) requireChild(diskChild, receipt);
    if (diskNote) requireNote(diskNote);
    if (bufferedNote) requireNote({ ...bufferedNote });

    const parent = artifacts.find((a) => a.id === parentId && a.sessionId === sessionId && a.type === "page");
    if (!parent || parent.version + 1 !== child.version || artifacts.some((a) => a.parentId === parentId && a.id !== artifactId)) {
      throw new Error("Standalone revision has inconsistent page lineage.");
    }
    const requireDurableVersion = (durableParent: Record<string, unknown> | Artifact | undefined,
      durableChild: Record<string, unknown> | Artifact | undefined) => {
      if (durableChild?.id !== artifactId || durableParent?.sessionId !== sessionId || durableParent.type !== "page" ||
        durableParent.version !== child.version - 1 || (!receipt.committed && durableParent.status !== "superseded")) {
        throw new Error("Standalone revision is missing its durable page version.");
      }
      requireChild(durableChild, receipt);
    };
    const checkVersion = () => requireDurableVersion(
      readSessionRecord(dir, "artifacts.json", "id", parentId),
      readSessionRecord(dir, "artifacts.json", "parentId", parentId),
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
        store.updateArtifactStatus(parentId, "superseded", "agent_supersede");
      }
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
  return result;
}
