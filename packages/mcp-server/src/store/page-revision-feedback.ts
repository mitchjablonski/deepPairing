import { createHash } from "node:crypto";
import { HtmlAnchorSchema, type Comment } from "@deeppairing/shared";
import { z } from "zod";

export const pageRevisionFeedbackIdsSchema = z.array(z.string().trim().min(1).max(128)).min(1).max(50)
  .refine((ids) => new Set(ids).size === ids.length, "Feedback comment IDs must be unique.");

export const pageRevisionFeedbackProofSchema = z.object({
  commentIds: pageRevisionFeedbackIdsSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  includesRuleOut: z.literal(true).optional(),
}).strict();
export type PageRevisionFeedbackProof = z.infer<typeof pageRevisionFeedbackProofSchema>;
export type PageRevisionFeedbackRefusal = { id: string; kind?: "question" | "suggestion" };

export class PageRevisionFeedbackConflictError extends Error {}

type ArtifactRecord = { id: string; parentId: unknown; sessionId: unknown; type: unknown; version: unknown };

/** Authorize only the exact backwards path, including the predecessor. */
export function provePageRevisionFeedback(
  artifacts: readonly ArtifactRecord[],
  comments: readonly Comment[],
  sessionId: string,
  parentId: string,
  requested: readonly string[],
  reconciledComments?: readonly Comment[],
  onRefusal?: (refusal: PageRevisionFeedbackRefusal) => void,
): PageRevisionFeedbackProof | undefined {
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  if (byId.size !== artifacts.length) return;
  const chain = new Set<string>();
  const lineage: Array<[string, number, string | null]> = [];
  for (let next = byId.get(parentId); next;) {
    const { id, parentId: previousId, version } = next;
    if (next.type !== "page" || next.sessionId !== sessionId || chain.has(id) ||
      typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 ||
      (previousId !== null && typeof previousId !== "string")) return;
    chain.add(id);
    lineage.push([id, version, previousId]);
    if (previousId === null) {
      if (version !== 1) return;
      break;
    }
    next = byId.get(previousId);
    if (!next || next.version !== version - 1) return;
  }
  const commentIds = [...requested].sort();
  const selected = new Set(commentIds);
  function selectedEvidence(rows: readonly Comment[], refuse?: typeof onRefusal) {
    const byCommentId = new Map<string, Comment | null>();
    for (const comment of rows) {
      if (!selected.has(comment.id)) continue;
      byCommentId.set(comment.id, byCommentId.has(comment.id) ? null : comment);
    }
    const evidence = [];
    let includesRuleOut = false;
    for (const id of commentIds) {
      const comment = byCommentId.get(id);
      const anchor = HtmlAnchorSchema.safeParse(comment?.target?.htmlAnchor);
      if (!comment || comment.author !== "human" || comment.sessionId !== sessionId ||
        !anchor.success || !chain.has(comment.target.artifactId)) {
        refuse?.({ id });
        return;
      }
      if (comment.intent === "question") {
        refuse?.({ id, kind: "question" });
        return;
      }
      if (comment.intent === "suggestion" || comment.suggestion !== undefined) {
        refuse?.({ id, kind: "suggestion" });
        return;
      }
      if (comment.intent !== undefined && comment.intent !== "comment") {
        refuse?.({ id });
        return;
      }
      evidence.push([id, [comment.target.artifactId, anchor.data, comment.content, comment.createdAt, comment.ruleOut]]);
      includesRuleOut ||= comment.ruleOut !== undefined;
    }
    return { serialized: JSON.stringify(evidence), includesRuleOut };
  }
  const evidence = selectedEvidence(comments, onRefusal);
  if (!evidence || (reconciledComments && selectedEvidence(reconciledComments)?.serialized !== evidence.serialized)) return;
  const digest = createHash("sha256").update(JSON.stringify([lineage, evidence.serialized])).digest("hex");
  return { commentIds, digest, ...(evidence.includesRuleOut ? { includesRuleOut: true as const } : {}) };
}
