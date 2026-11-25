import type { Comment } from "@deeppairing/shared";

/**
 * #714 gap 7 — the page's comment list as a REVIEW QUEUE: each anchored root
 * comment gets one honest state, the queue filters on it, and the frame's pin
 * takes its colour from it.
 *
 * Type-only imports: pure derivation, no Zod.
 *
 * States, in precedence order (each comment is in exactly one bucket):
 *  - addressed — the agent dealt with it, in one of three distinct ways, each
 *    said in its own words:
 *      · "revision": a page revision named it addressed (standalone
 *        `revise-page --ack-comment-id` stamps `addressedIn` on the comment);
 *      · "answer": the agent answered it (`answeredByCommentId`, or an agent
 *        reply in its thread after it);
 *      · "resolved": you resolved it yourself (`humanResolvedAt`).
 *    Addressed wins over orphaned: a fix often removes the very text the
 *    comment pointed at.
 *  - orphaned — its spot is not on this version of the page.
 *  - open — everything else. `seen` is the MCP drain-on-read bit
 *    (`acknowledged` with no revision stamp): the agent has READ it, which is
 *    not the same as having done anything about it, so it stays open.
 */

export type PageCommentState =
  | { kind: "open"; seen: boolean }
  | { kind: "addressed"; via: "revision"; version: number }
  | { kind: "addressed"; via: "answer" }
  | { kind: "addressed"; via: "resolved" }
  | { kind: "orphaned" };

export type QueueFilter = "open" | "addressed" | "orphaned";
export const QUEUE_FILTERS: readonly QueueFilter[] = ["open", "addressed", "orphaned"];
export const QUEUE_FILTER_LABEL: Record<QueueFilter, string> = {
  open: "Open",
  addressed: "Addressed",
  orphaned: "Orphaned",
};

/** The colour class a pin is drawn with in the frame (orphaned pins are not
 *  drawn: their spot isn't on the page). */
export type PinState = "open" | "addressed";

/** Every comment under `root` in its thread (replies to replies included). */
export function threadReplies(root: Comment, all: readonly Comment[]): Comment[] {
  const children = new Map<string, Comment[]>();
  for (const c of all) {
    if (!c.parentCommentId) continue;
    const list = children.get(c.parentCommentId);
    if (list) list.push(c);
    else children.set(c.parentCommentId, [c]);
  }
  const out: Comment[] = [];
  const seen = new Set<string>([root.id]);
  const stack = [...(children.get(root.id) ?? [])];
  while (stack.length) {
    const c = stack.shift()!;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    stack.push(...(children.get(c.id) ?? []));
  }
  return out;
}

export function deriveCommentState(root: Comment, replies: readonly Comment[], missing: boolean): PageCommentState {
  const addressedIn = root.addressedIn;
  if (addressedIn && Number.isInteger(addressedIn.version) && addressedIn.version > 0) {
    return { kind: "addressed", via: "revision", version: addressedIn.version };
  }
  if (root.answeredByCommentId || replies.some((r) => r.author === "agent" && r.createdAt >= root.createdAt)) {
    return { kind: "addressed", via: "answer" };
  }
  if (root.humanResolvedAt) return { kind: "addressed", via: "resolved" };
  if (missing) return { kind: "orphaned" };
  return { kind: "open", seen: root.acknowledged === true };
}

export function stateFilter(state: PageCommentState): QueueFilter {
  return state.kind;
}

export function pinState(state: PageCommentState): PinState {
  return state.kind === "addressed" ? "addressed" : "open";
}

/** Short, honest wording for the state chip; `title` says what it means. */
export function stateLabel(state: PageCommentState): { text: string; title: string } {
  switch (state.kind) {
    case "addressed":
      if (state.via === "revision") {
        return {
          text: `Addressed in v${state.version}`,
          title: `The agent revised the page and named this comment as addressed in v${state.version}. Check the change yourself.`,
        };
      }
      if (state.via === "answer") return { text: "Answered by the agent", title: "The agent replied to this comment." };
      return { text: "Resolved by you", title: "You marked this resolved." };
    case "orphaned":
      return {
        text: "Not found in this version",
        title: "The spot this comment points at is not on this version of the page, and nothing has addressed it.",
      };
    case "open":
      return state.seen
        ? {
            text: "Seen by agent",
            title: "The agent has read this comment (check_feedback) but hasn't answered it or named it addressed in a revision.",
          }
        : { text: "Open", title: "Delivered to the session; the agent hasn't acted on it yet." };
  }
}

export interface QueueEntry {
  comment: Comment;
  /** Pin number - 1 (the order the frame numbers pins in). */
  index: number;
  state: PageCommentState;
  replies: number;
  /** Its spot is not on this version (true for every orphaned entry; can also
   *  be true for an addressed one, whose fix removed the text). */
  missing: boolean;
}

export function buildQueue(
  anchored: readonly Comment[],
  all: readonly Comment[],
  isMissing: (comment: Comment, index: number) => boolean,
): QueueEntry[] {
  return anchored.map((comment, index) => {
    const replies = threadReplies(comment, all);
    const missing = isMissing(comment, index);
    return { comment, index, replies: replies.length, missing, state: deriveCommentState(comment, replies, missing) };
  });
}

export function queueCounts(entries: readonly QueueEntry[]): Record<QueueFilter, number> {
  const counts: Record<QueueFilter, number> = { open: 0, addressed: 0, orphaned: 0 };
  for (const e of entries) counts[stateFilter(e.state)]++;
  return counts;
}
