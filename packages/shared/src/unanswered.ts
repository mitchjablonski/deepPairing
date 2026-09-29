import type { Comment } from "./schemas/comment.js";

/**
 * The single source of truth for "a human question still awaiting the agent",
 * PLUS the thread grouping it walks over. Shared by the web UI and the SERVER
 * (first-call hint, check_feedback carryover, daemon/context-bank counts) so
 * they can never drift.
 *
 * #430 PR 1c (review of #448) — the rule is PER QUESTION. A human question
 * (`intent: "question"`) is ANSWERED only when
 *   - it carries an out-of-band answer (`answeredByCommentId`), or
 *   - an AGENT message exists AFTER it in its thread,
 * and it is CLOSED when the human resolved it (`humanResolvedAt`). Human
 * non-question replies are context and change nothing.
 *
 * It replaces the old thread TAIL-walk, which returned at most one open question
 * per thread: a human follow-up Q2 after Q1 hid Q1, and resolving Q2 made the
 * whole thread read as answered — so Q1 was never delivered to the agent in
 * check_feedback and never counted in the UI. Every count below is a count of
 * QUESTIONS; the only thread-level predicate is named as such
 * (`threadHasOpenQuestion`).
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

const isQuestion = (m: Comment): boolean =>
  m.author === "human" && (m as { intent?: string }).intent === "question";
const isClosed = (m: Comment): boolean => {
  const x = m as { answeredByCommentId?: string | null; humanResolvedAt?: string | null };
  return !!x.answeredByCommentId || !!x.humanResolvedAt;
};

/**
 * The OPEN questions of one thread, chronological: walk root → replies; an
 * agent message answers every question before it; out-of-band answers and human
 * resolutions close a question individually.
 */
export function openQuestionsInThread(root: Comment, replies: Comment[]): Comment[] {
  let waiting: Comment[] = [];
  for (const m of [root, ...replies]) {
    if (m.author === "agent") {
      waiting = [];
      continue;
    }
    if (isQuestion(m) && !isClosed(m)) waiting.push(m);
  }
  return waiting;
}

/** THREAD-level: does this thread hold at least one open question? (The rail's
 *  filter and its per-thread "awaiting" marker.) Derived from the per-question
 *  rule, not a second definition. */
export function threadHasOpenQuestion(root: Comment, replies: Comment[]): boolean {
  return openQuestionsInThread(root, replies).length > 0;
}

/** One unanswered-question queue entry. `question` is the open question to
 *  answer / jump to (for a follow-up asked as a reply it is NOT the thread
 *  `root`); `root`/`replies` keep thread context; `artifactId` is the anchor. */
export interface UnansweredQuestion {
  artifactId: string;
  /** The open question to answer (answer_question commentId = question.id). */
  question: Comment;
  /** The thread root (may be a non-question comment for reply-questions). */
  root: Comment;
  replies: Comment[];
}

/**
 * Every OPEN question across a flat comment list (one entry per question, not
 * per thread), sorted oldest-first by the question's createdAt so the
 * earliest-owed question leads. The server's carryover queue and every UI count
 * derive from this.
 */
export function collectUnansweredQuestions(comments: Comment[]): UnansweredQuestion[] {
  const out: UnansweredQuestion[] = [];
  for (const t of buildThreads(comments)) {
    for (const question of openQuestionsInThread(t.root, t.replies)) {
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

/** How many QUESTIONS are open across a flat comment list. */
export function countUnansweredQuestions(comments: Comment[]): number {
  return collectUnansweredQuestions(comments).length;
}
