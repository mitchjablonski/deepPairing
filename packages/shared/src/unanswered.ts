import type { Comment } from "./schemas/comment.js";

/**
 * The single source of truth for "a human question still awaiting the agent",
 * PLUS the thread grouping it walks over. Shipped originally in the web UI
 * (lib/threading + lib/unanswered) where ConversationRail, TurnIndicator and the
 * Conversation badge all lean on it; #192 lifts it into @deeppairing/shared so
 * the SERVER can reuse the EXACT SAME predicate to enumerate the unanswered-
 * question queue (first-call hint + check_feedback carryover) rather than
 * inventing a second, drifting definition. The web libs now re-export from here,
 * so their public API is unchanged.
 *
 * A thread is unanswered when — walking its chronological messages from the TAIL
 * back to the root — the first SUBSTANTIVE message is an OPEN human question (one
 * lacking an out-of-band answer `answeredByCommentId` and a human resolution
 * `humanResolvedAt`). The walk: an agent message means the agent had the last
 * word (not waiting); an open human question means waiting; a closed human
 * question means done; a human non-question ("btw also…") is context and the
 * walk continues. No open human question anywhere → not waiting. When `replies`
 * is empty the tail IS the root.
 */

/** Walk to the thread root; orphans (parent not in the set) root at self. On a
 *  parent CYCLE (data corruption), every member deterministically roots at the
 *  cycle's chronologically-first comment — same answer from any entry point, so
 *  the whole cycle renders as one thread instead of vanishing. */
export function threadRootId(comment: Comment, byId: Map<string, Comment>): string {
  let current = comment;
  const seen = new Set<string>([current.id]);
  while (current.parentCommentId && byId.has(current.parentCommentId)) {
    const parent = byId.get(current.parentCommentId)!;
    if (seen.has(parent.id)) {
      const cycle: Comment[] = [];
      let node = parent;
      do {
        cycle.push(node);
        node = byId.get(node.parentCommentId ?? "")!;
      } while (node && node.id !== parent.id && cycle.length <= byId.size);
      cycle.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      return cycle[0]?.id ?? current.id;
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

/** True when the thread's TAIL-walk lands on an open human question. */
/**
 * The tail-walk itself, returning WHICH comment is the open question the thread
 * is waiting on (or null when it's not waiting). This is the load-bearing detail
 * behind `isUnansweredQuestion`: for the I4 common flow — human comment → agent
 * reply → human asks a FOLLOW-UP question as a reply — the open question is the
 * FOLLOW-UP (the thread TAIL), NOT the thread root. Any surface that needs to
 * ANSWER the question (carryover delivery, the resume banner's jump target) must
 * target THIS comment, not the root, or it answers the wrong comment and the
 * queue goes silent while the real question is never addressed.
 */
export function findOpenQuestion(comment: Comment, replies: Comment[]): Comment | null {
  const isOpenHumanQuestion = (m: Comment): boolean => {
    const x = m as {
      intent?: string;
      answeredByCommentId?: string | null;
      humanResolvedAt?: string | null;
    };
    return (
      m.author === "human" &&
      x.intent === "question" &&
      !x.answeredByCommentId &&
      !x.humanResolvedAt
    );
  };
  const chain = [comment, ...replies];
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!;
    if (m.author !== "human") return null; // agent had the last substantive word
    if ((m as { intent?: string }).intent === "question") return isOpenHumanQuestion(m) ? m : null;
    // human non-question — context; keep walking back
  }
  return null;
}

export function isUnansweredQuestion(comment: Comment, replies: Comment[]): boolean {
  return findOpenQuestion(comment, replies) !== null;
}

/**
 * Count unanswered human questions across a FLAT comment list — builds transitive
 * threads then applies the shared predicate to each root, so the count matches
 * every rendering surface.
 */
export function countUnansweredQuestions(comments: Comment[]): number {
  let n = 0;
  for (const t of buildThreads(comments)) {
    if (isUnansweredQuestion(t.root, t.replies)) n++;
  }
  return n;
}

/** One unanswered-question queue entry. `question` is the ACTUAL open-question
 *  comment the tail-walk landed on — the one to answer / jump to (which for a
 *  follow-up asked as a reply is NOT the thread `root`). `root` is kept for
 *  thread context; `artifactId` is the drill-in reference. */
export interface UnansweredQuestion {
  artifactId: string;
  /** The open question to answer (answer_question commentId = question.id). */
  question: Comment;
  /** The thread root (may be a non-question comment for reply-questions). */
  root: Comment;
  replies: Comment[];
}

/**
 * #192 (serving H1) — enumerate the project's unanswered human questions from a
 * flat comment list (a session store's full comment set). The queue whose
 * definition is the SAME tail-walk every UI surface uses, exposed for the server
 * so a question asked AFTER a run ends gets picked up on the NEXT run without the
 * human re-raising it. Sorted oldest-first by the QUESTION's createdAt so the
 * earliest-owed question leads.
 */
export function collectUnansweredQuestions(comments: Comment[]): UnansweredQuestion[] {
  const out: UnansweredQuestion[] = [];
  for (const t of buildThreads(comments)) {
    const question = findOpenQuestion(t.root, t.replies);
    if (question) {
      // Anchor on the QUESTION's artifact (a reply inherits the root's target,
      // but read from the question comment so an odd reply target still points
      // where the human is looking).
      const artifactId = question.target?.artifactId ?? t.root.target?.artifactId ?? "";
      out.push({ artifactId, question, root: t.root, replies: t.replies });
    }
  }
  out.sort((a, b) => (a.question.createdAt ?? "").localeCompare(b.question.createdAt ?? ""));
  return out;
}
