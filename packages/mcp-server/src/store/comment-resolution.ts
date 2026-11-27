import type { Comment } from "@deeppairing/shared";

/** A later human reply anywhere in a thread supersedes an explicit resolve. */
export function effectiveHumanResolution(comments: readonly Comment[]) {
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
    const resolvedAt = Date.parse(stamp);
    const seen = new Set([comment.id]);
    const pending = [...(replies.get(comment.id) ?? [])];
    while (pending.length) {
      const reply = pending.pop()!;
      if (seen.has(reply.id) || reply.sessionId !== comment.sessionId) continue;
      seen.add(reply.id);
      if (reply.author === "human" && Date.parse(reply.createdAt) > resolvedAt) return undefined;
      for (const nested of replies.get(reply.id) ?? []) pending.push(nested);
    }
    return stamp;
  };
}
