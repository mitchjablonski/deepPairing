import type { Artifact, Comment } from "@deeppairing/shared";
import type { CommentResolutionSnapshot } from "./store-interface.js";

export function commentResolutionSnapshot(comment: Comment): CommentResolutionSnapshot {
  return { id: comment.id, resolvedAt: comment.humanResolvedAt, token: comment.humanResolutionToken };
}

function time(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Resolve wins ties with a human message. Answers and revisions win ties
 * with Resolve, matching the companion page queue's event order. */
export function effectiveHumanResolution(comments: readonly Comment[], artifacts: readonly Pick<Artifact, "id" | "createdAt">[]) {
  const revisionTimes = new Map(artifacts.map((artifact) => [artifact.id, artifact.createdAt]));
  const replies = new Map<string, Comment[]>();
  for (const comment of comments) {
    if (!comment.parentCommentId) continue;
    const children = replies.get(comment.parentCommentId);
    if (children) children.push(comment);
    else replies.set(comment.parentCommentId, [comment]);
  }

  return (comment: Comment): Comment["humanResolvedAt"] => {
    const stamp = comment.humanResolvedAt;
    if (!stamp) return stamp;
    const resolvedAt = time(stamp);
    const rootAt = time(comment.createdAt) ?? 0;
    if (resolvedAt === undefined || rootAt > resolvedAt) return undefined;
    const addressed = comment.addressedIn;
    if (addressed && Number.isInteger(addressed.version) && addressed.version > 0) {
      const revisionAt = time(addressed.at) ?? time(revisionTimes.get(addressed.artifactId)) ?? rootAt;
      if (revisionAt >= resolvedAt) return undefined;
    }
    const seen = new Set([comment.id]);
    const pending = [...(replies.get(comment.id) ?? [])];
    while (pending.length) {
      const reply = pending.pop()!;
      if (seen.has(reply.id) || reply.sessionId !== comment.sessionId) continue;
      seen.add(reply.id);
      const replyAt = time(reply.createdAt) ?? rootAt;
      if (replyAt > resolvedAt || (reply.author === "agent" && replyAt === resolvedAt)) return undefined;
      for (const nested of replies.get(reply.id) ?? []) pending.push(nested);
    }
    if (comment.answeredByCommentId && !seen.has(comment.answeredByCommentId) && rootAt >= resolvedAt) return undefined;
    return stamp;
  };
}
