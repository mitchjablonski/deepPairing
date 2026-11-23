import { createHash } from "node:crypto";
import { HtmlAnchorSchema, type Comment } from "@deeppairing/shared";
import { z } from "zod";

export const pageRevisionFeedbackIdsSchema = z.array(z.string().trim().min(1).max(128)).min(1).max(50)
  .refine((ids) => new Set(ids).size === ids.length, "Feedback comment IDs must be unique.");

export const pageRevisionFeedbackProofSchema = z.object({
  commentIds: pageRevisionFeedbackIdsSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type PageRevisionFeedbackProof = z.infer<typeof pageRevisionFeedbackProofSchema>;

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
  function selectedEvidence(rows: readonly Comment[]) {
    const byCommentId = new Map<string, unknown[]>();
    for (const comment of rows) {
      if (!selected.has(comment.id)) continue;
      const anchor = HtmlAnchorSchema.safeParse(comment.target?.htmlAnchor);
      if (byCommentId.has(comment.id) || comment.author !== "human" || comment.sessionId !== sessionId ||
        !anchor.success || !chain.has(comment.target.artifactId) || comment.suggestion !== undefined ||
        (comment.intent !== undefined && comment.intent !== "comment")) return;
      byCommentId.set(comment.id, [comment.target.artifactId, anchor.data, comment.content, comment.createdAt, comment.ruleOut]);
    }
    if (byCommentId.size !== selected.size) return;
    return JSON.stringify(commentIds.map((id) => [id, byCommentId.get(id)]));
  }
  const evidence = selectedEvidence(comments);
  if (!evidence || (reconciledComments && selectedEvidence(reconciledComments) !== evidence)) return;
  const digest = createHash("sha256").update(JSON.stringify([lineage, evidence])).digest("hex");
  return { commentIds, digest };
}
