import type { Comment } from "@deeppairing/shared";

/**
 * #714 gap 7 — the page's comment list as a REVIEW QUEUE: each anchored root
 * comment gets one honest state, the queue filters on it, and the frame's pin
 * takes its colour from it.
 *
 * Type-only imports: pure derivation, no Zod.
 *
 * The LATEST WORD in the thread decides (#722 review):
 *  - the agent's last act — a reply (or `answeredByCommentId`), or a page
 *    revision that named the comment addressed (`addressedIn`, timed by its
 *    `at` or the revision's own createdAt) — after the latest human message
 *    → addressed ("Answered by the agent" / "Addressed in vN"). A plain agent
 *    clarifying question also counts as answered; your follow-up reopens it;
 *  - your own resolve (`humanResolvedAt`) as the latest act → "Resolved by you";
 *  - a human reply AFTER any of those → open again, shown as "Reopened";
 *  - otherwise open. `seen` is the MCP drain-on-read bit (`acknowledged`
 *    with no revision stamp): the agent READ it, which is not acting on it.
 * An open (or reopened) comment whose spot is not on this version is
 * orphaned; addressed and resolved win over orphaned, because a fix often
 * removes the very text the comment pointed at.
 */

export type PageCommentState =
  | { kind: "open"; seen: boolean; reopened?: boolean }
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

export interface DeriveOptions {
  /** createdAt of a revision artifact, for an `addressedIn` stamp without `at`. */
  revisionAt?: (artifactId: string) => string | undefined;
}

type ThreadEvent = { t: number; kind: "human" | "answer" | "revision" | "resolve"; version?: number };
/** At equal times an act outranks a message (fallback times equal the root's). */
const RANK: Record<ThreadEvent["kind"], number> = { human: 0, resolve: 1, answer: 2, revision: 3 };

function time(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

export function deriveCommentState(
  root: Comment,
  replies: readonly Comment[],
  missing: boolean,
  opts: DeriveOptions = {},
): PageCommentState {
  const rootT = time(root.createdAt) ?? 0;
  const events: ThreadEvent[] = [{ t: rootT, kind: "human" }];
  for (const r of replies) {
    const t = time(r.createdAt) ?? rootT;
    events.push({ t, kind: r.author === "agent" ? "answer" : "human" });
  }
  // An answer link whose reply isn't in this thread still counts, as just
  // after the root (a later human reply reopens it).
  if (root.answeredByCommentId && !replies.some((r) => r.id === root.answeredByCommentId)) {
    events.push({ t: rootT, kind: "answer" });
  }
  const addressedIn = root.addressedIn;
  if (addressedIn && Number.isInteger(addressedIn.version) && addressedIn.version > 0) {
    const t = time(addressedIn.at) ?? time(opts.revisionAt?.(addressedIn.artifactId)) ?? rootT;
    events.push({ t, kind: "revision", version: addressedIn.version });
  }
  const resolvedT = time(root.humanResolvedAt);
  if (resolvedT !== undefined) events.push({ t: resolvedT, kind: "resolve" });

  let latest = events[0]!;
  for (const e of events) if (e.t > latest.t || (e.t === latest.t && RANK[e.kind] > RANK[latest.kind])) latest = e;
  if (latest.kind === "revision") return { kind: "addressed", via: "revision", version: latest.version! };
  if (latest.kind === "answer") return { kind: "addressed", via: "answer" };
  if (latest.kind === "resolve") return { kind: "addressed", via: "resolved" };
  if (missing) return { kind: "orphaned" };
  const reopened = events.some((e) => e.kind !== "human");
  return reopened ? { kind: "open", seen: root.acknowledged === true, reopened: true } : { kind: "open", seen: root.acknowledged === true };
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
      if (state.reopened) {
        return {
          text: "Reopened",
          title: "You replied after the agent's answer, the revision that addressed it, or your own resolve, so it's open again.",
        };
      }
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
  /** #714 — the state the thread would have without your resolve (set only
   *  when you resolved it): what "Reopen" returns it to. */
  withoutResolve?: PageCommentState;
}

export function buildQueue(
  anchored: readonly Comment[],
  all: readonly Comment[],
  isMissing: (comment: Comment, index: number) => boolean,
  opts: DeriveOptions = {},
): QueueEntry[] {
  return anchored.map((comment, index) => {
    const replies = threadReplies(comment, all);
    const missing = isMissing(comment, index);
    const state = deriveCommentState(comment, replies, missing, opts);
    const entry: QueueEntry = { comment, index, replies: replies.length, missing, state };
    if (comment.humanResolvedAt) {
      entry.withoutResolve = deriveCommentState({ ...comment, humanResolvedAt: null }, replies, missing, opts);
    }
    return entry;
  });
}

export function queueCounts(entries: readonly QueueEntry[]): Record<QueueFilter, number> {
  const counts: Record<QueueFilter, number> = { open: 0, addressed: 0, orphaned: 0 };
  for (const e of entries) counts[stateFilter(e.state)]++;
  return counts;
}

/**
 * #714 — the reviewer's own resolve action on a queue row, over the existing
 * comment resolution (`humanResolvedAt`, the same stamp "Mark resolved" sets
 * on a question). No new lifecycle: resolving is your latest act, so the row
 * reads "Resolved by you"; reopening withdraws that stamp, so the row reads
 * whatever the thread said before it (open, or the agent's answer).
 *
 *  - resolve: any row that isn't currently resolved by you — open, reopened,
 *    orphaned, or addressed by the agent (confirming it's done);
 *  - reopen: a row resolved by you. Labelled "Reopen" when that brings it
 *    back to open, "Undo resolve" when the agent had already answered or
 *    addressed it (replying in its thread is how you reopen that).
 * Plain comments only: an Ask is a question the agent owes an answer to,
 * resolved through its own "Mark resolved". Never on your answer to one of
 * the page's asks (`answersAsk`, #725): a resolved comment stops answering
 * the ask, so resolving it would reopen the ask while telling the agent
 * "no change needed" in the same breath.
 */
export type ResolveAction =
  | { kind: "resolve"; label: "Resolve"; title: string }
  | { kind: "reopen"; label: "Reopen" | "Undo resolve"; title: string };

export function resolveAction(entry: QueueEntry, opts: { answersAsk?: boolean } = {}): ResolveAction | null {
  const c = entry.comment;
  if (c.author !== "human" || c.parentCommentId || c.intent === "question" || opts.answersAsk) return null;
  if (entry.state.kind === "addressed" && entry.state.via === "resolved") {
    const back = entry.withoutResolve;
    if (back && back.kind === "addressed") {
      return {
        kind: "reopen",
        label: "Undo resolve",
        title: `Withdraw your resolve; it goes back to "${stateLabel(back).text}". Reply in its thread to reopen it.`,
      };
    }
    return { kind: "reopen", label: "Reopen", title: "Withdraw your resolve; the comment is open again for the agent." };
  }
  return {
    kind: "resolve",
    label: "Resolve",
    title:
      entry.state.kind === "addressed"
        ? "Mark it done yourself: you've checked the agent's answer or revision."
        : "Mark it done yourself: it no longer needs the agent. The agent sees it as resolved by you.",
  };
}
