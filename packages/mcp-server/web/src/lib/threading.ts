import type { Comment } from "@deeppairing/shared";

/**
 * F7 — transitive thread flattening. Both renderers used to nest EXACTLY one
 * level: a depth-2 comment (the rail's own Reply button targets the LAST
 * reply, and answer_question replies to reply ids) was neither a root nor a
 * rendered reply — the user's follow-up visibly vanished on submit, and the
 * agent's answer to it was invisible too. Threads are now root → ALL
 * descendants, flattened chronologically (a linear transcript reads better
 * than deep stairs at these volumes).
 */

/** Walk to the thread root; orphans (parent not in the set) root at self.
 *  On a parent CYCLE (data corruption), every member deterministically roots
 *  at the cycle's chronologically-first comment — same answer from any entry
 *  point, so the whole cycle renders as one thread instead of vanishing
 *  (nobody roots at self in a mutual cycle; own test caught the vanish). */
export function threadRootId(comment: Comment, byId: Map<string, Comment>): string {
  let current = comment;
  const seen = new Set<string>([current.id]);
  while (current.parentCommentId && byId.has(current.parentCommentId)) {
    const parent = byId.get(current.parentCommentId)!;
    if (seen.has(parent.id)) {
      // Cycle: root at the chronologically-first member of the walk.
      const members = [...seen].map((id) => byId.get(id)!).filter(Boolean);
      members.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      return members[0]?.id ?? current.id;
    }
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

export interface Thread {
  root: Comment;
  /** ALL descendants of the root, any depth, chronological. */
  replies: Comment[];
}

const byTime = (a: Comment, b: Comment) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "");

/** Group a comment set into transitive threads, roots chronological. */
export function buildThreads(comments: Comment[]): Thread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const descendants = new Map<string, Comment[]>();
  const roots: Comment[] = [];
  for (const c of comments) {
    const rootId = threadRootId(c, byId);
    if (rootId === c.id) {
      roots.push(c);
    } else {
      const arr = descendants.get(rootId) ?? [];
      arr.push(c);
      descendants.set(rootId, arr);
    }
  }
  return roots.sort(byTime).map((root) => ({
    root,
    replies: (descendants.get(root.id) ?? []).sort(byTime),
  }));
}
