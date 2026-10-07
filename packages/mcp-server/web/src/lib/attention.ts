import type { Artifact, Comment, Request } from "@deeppairing/shared";
import { isDraftAwaitingReview } from "./pending";
import { unansweredQuestionIds } from "./unanswered";

/**
 * #430 PR 1a — the ONE attention model (docs/design/attention-hierarchy.md §4.1,
 * §4.3). A pure selector: no React, no stores, no window. Nothing renders from
 * it yet (PR 2 adds the Next-up bar); it exists so every later surface reads the
 * same lanes, the same `next`, and the same precedence.
 *
 * It REPRODUCES today's counting rules on purpose — where current surfaces
 * disagree, the rule below is today's, and the follow-up PR that changes it is
 * named at the spot:
 *   - Decide == `isDraftAwaitingReview` == computePending's drafts (and the
 *     server's computeDaemonPendingCount type set) — parity-tested.
 *   - Waiting questions are PER QUESTION (PR 1c): `unansweredQuestionIds` —
 *     answered only by `answeredByCommentId` or an agent reply after it in its
 *     thread; cleared by `humanResolvedAt`. Two consecutive open questions in
 *     one thread are two items (the retired thread tail-walk said one).
 *   - Agent activity is NOT computed here: the 45s/60s windows are PR 1b, and
 *     the #204 90s resume hysteresis stays its own threshold. Callers pass the
 *     agent state they already derive.
 *   - Read == drafts that are not awaiting review (explainer, reasoning) — the
 *     same split PR 0's sidebar dot uses.
 *   - The `revised` status is Waiting here (the agent owes a revision); its
 *     violet sidebar colour is unchanged until PR 1d.
 *   - `why`/`after` copy (§4.4) is derived in PR 2 with the bar that shows it.
 */

export type DecideKind = "decision" | "review-blocking" | "review";
export type WaitingKind = "question" | "request" | "revision";
export type FailureKind = "disconnected" | "stale-daemon" | "replay" | "snapshot-unavailable" | "session-conflict";

export interface AttentionItem {
  id: string;
  title: string;
  /** Artifact id the item opens (a question's anchor artifact; a request has none). */
  artifactId?: string;
  createdAt: string;
  kind: DecideKind | WaitingKind | "read" | "flag" | "held";
  /** Decisions only: the decision content's optional `stakes`. */
  stakes?: "high" | "medium" | "low";
  /** Annotations, never a separate Decide item (§4.3). */
  flags?: "possible-secret"[];
  /** #457 D2 (§4.1, §4.6) — the owning session's name, set ONLY when the store
   *  holds more than one session (one session needs no name). */
  sessionLabel?: string;
}

export interface AttentionInput {
  artifacts: Artifact[];
  /** Per-artifact comment buckets, as the artifact store holds them. */
  comments?: Record<string, Comment[]>;
  requests?: Request[];
  /** #457 D2 — session id → display name (lib/sessionLabel). Missing ids fall
   *  back to the raw id. */
  sessionLabels?: Record<string, string>;
  system?: {
    disconnected?: boolean;
    staleDaemon?: boolean;
    replay?: boolean;
    snapshotUnavailable?: boolean;
    sessionConflict?: boolean;
    /** Unread stance holds (preflight blocks) to keep as a read-only record. */
    holds?: { id: string; title: string; at: string }[];
  };
}

export type PrimaryLane = "decide" | "flag" | "waiting" | "held" | "nothing";
export type SummaryLane = "high-decision" | "decide" | "flags" | "waiting" | "held" | "read";

export interface Attention {
  /** Oldest Decide item (oldest-first, the user's decision). */
  next: AttentionItem | null;
  /** Open decisions with `stakes === "high"` other than `next` ("+N high decision"). */
  highDecisionsBeyondNext: number;
  lanes: {
    decide: AttentionItem[];
    read: AttentionItem[];
    waiting: AttentionItem[];
    flags: AttentionItem[];
    held: AttentionItem[];
  };
  /** The one-line bar's model: rules 1-3 of §4.3. */
  line: {
    /** Rule 1 — the first active failure, shown whatever else is true. */
    prefix: FailureKind | null;
    /** Rule 2 — first non-empty of decide → flag → waiting → held → nothing. */
    primary: { lane: PrimaryLane; item: AttentionItem | null };
    /** Rule 3 — every other non-empty lane, fixed order, with counts. */
    summary: { lane: SummaryLane; count: number }[];
  };
}

/** Decide kinds: a decision; drafts the agent is BLOCKED on; drafts that owe a
 *  verdict but don't block it (§0 lane table). */
const BLOCKING_REVIEW = new Set(["plan", "changeset", "code_change"]);
function decideKind(a: Artifact): DecideKind {
  if (a.type === "decision") return "decision";
  return BLOCKING_REVIEW.has(a.type) ? "review-blocking" : "review";
}

function stakesOf(a: Artifact): AttentionItem["stakes"] {
  const s = (a.content as { stakes?: unknown } | null)?.stakes;
  return s === "high" || s === "medium" || s === "low" ? s : undefined;
}

const hasSecret = (a: Artifact): boolean =>
  ((a as { secretWarnings?: unknown[] }).secretWarnings?.length ?? 0) > 0;

/** Oldest first; ties keep input order (Array.prototype.sort is stable). */
const byOldest = (x: { createdAt: string }, y: { createdAt: string }) =>
  (x.createdAt ?? "").localeCompare(y.createdAt ?? "");

/** Fixed prefix precedence when several failures coincide: the one that most
 *  limits what the human can do first. */
const FAILURE_ORDER: [keyof NonNullable<AttentionInput["system"]>, FailureKind][] = [
  ["disconnected", "disconnected"],
  ["staleDaemon", "stale-daemon"],
  ["sessionConflict", "session-conflict"],
  ["snapshotUnavailable", "snapshot-unavailable"],
  ["replay", "replay"],
];

export function computeAttention(input: AttentionInput): Attention {
  const artifacts = input.artifacts;
  const system = input.system ?? {};

  const decide: AttentionItem[] = [];
  const read: AttentionItem[] = [];
  const flags: AttentionItem[] = [];
  const revisions: AttentionItem[] = [];
  for (const a of artifacts) {
    const secret = hasSecret(a);
    if (isDraftAwaitingReview(a)) {
      decide.push({
        id: a.id, title: a.title, artifactId: a.id, createdAt: a.createdAt, kind: decideKind(a),
        ...(a.type === "decision" && stakesOf(a) ? { stakes: stakesOf(a) } : {}),
        ...(secret ? { flags: ["possible-secret"] as "possible-secret"[] } : {}),
      });
    } else if (a.status === "draft") {
      // Not awaiting review (explainer, reasoning): for you to read.
      read.push({ id: a.id, title: a.title, artifactId: a.id, createdAt: a.createdAt, kind: "read" });
    } else if (a.status === "revised") {
      revisions.push({ id: a.id, title: a.title, artifactId: a.id, createdAt: a.createdAt, kind: "revision" });
    }
    // A possible-secret warning is a System flag on ANY artifact (it has no
    // resolve action and can sit on non-drafts, so it is never a Decide item).
    // PR 2: a flag on a superseded/retracted artifact is permanent (the banner
    // has no resolve action), so with Decide empty it would hold the primary
    // slot forever. That matches the doc today; decide in PR 2 whether a flag
    // on a dead artifact belongs in the summary only.
    if (secret) flags.push({ id: a.id, title: a.title, artifactId: a.id, createdAt: a.createdAt, kind: "flag" });
  }
  decide.sort(byOldest);
  read.sort(byOldest);
  flags.sort(byOldest);

  const allComments = Object.values(input.comments ?? {}).flat();
  const openQuestions = unansweredQuestionIds(allComments);
  const questions: AttentionItem[] = allComments
    .filter((c) => openQuestions.has(c.id))
    .map((c) => ({
      id: c.id,
      title: c.content,
      artifactId: c.target?.artifactId || undefined,
      createdAt: c.createdAt,
      kind: "question",
    }));
  const requests: AttentionItem[] = (input.requests ?? [])
    .filter((r) => !r.servedByArtifactId)
    .map((r) => ({ id: r.id, title: r.text, createdAt: r.createdAt, kind: "request" }));
  const waiting = [...questions, ...requests, ...revisions].sort(byOldest);

  const held: AttentionItem[] = (system.holds ?? [])
    .map((h) => ({ id: h.id, title: h.title, createdAt: h.at, kind: "held" as const }))
    .sort(byOldest);

  const next = decide[0] ?? null;
  const highDecisionsBeyondNext = decide.filter(
    (d) => d !== next && d.kind === "decision" && d.stakes === "high",
  ).length;

  // Rule 1 — failure prefix.
  const prefix = FAILURE_ORDER.find(([key]) => system[key] === true)?.[1] ?? null;

  // Rule 2 — the primary slot.
  const primary: Attention["line"]["primary"] =
    next ? { lane: "decide", item: next }
    : flags.length ? { lane: "flag", item: flags[0]! }
    : waiting.length ? { lane: "waiting", item: waiting[0]! }
    : held.length ? { lane: "held", item: held[0]! }
    : { lane: "nothing", item: null };

  // Rule 3 — the summary. `Decide N` is the queue size and shows whenever Decide
  // is non-empty (the worked table's first row: `+N high decision · Decide N`);
  // every OTHER lane is omitted only when it holds the primary slot.
  const summary: Attention["line"]["summary"] = [];
  if (primary.lane === "decide" && highDecisionsBeyondNext > 0) {
    summary.push({ lane: "high-decision", count: highDecisionsBeyondNext });
  }
  if (decide.length) summary.push({ lane: "decide", count: decide.length });
  if (flags.length && primary.lane !== "flag") summary.push({ lane: "flags", count: flags.length });
  if (waiting.length && primary.lane !== "waiting") summary.push({ lane: "waiting", count: waiting.length });
  if (held.length && primary.lane !== "held") summary.push({ lane: "held", count: held.length });
  if (read.length) summary.push({ lane: "read", count: read.length });

  // #457 D2 — name the session on every item when more than one is merged.
  const sessionIds = new Set(artifacts.map((a) => a.sessionId).filter(Boolean));
  if (sessionIds.size > 1) {
    const sessionOf = new Map(artifacts.map((a) => [a.id, a.sessionId] as const));
    for (const it of [...decide, ...read, ...flags, ...waiting]) {
      const sid = it.artifactId ? sessionOf.get(it.artifactId) : undefined;
      if (sid) it.sessionLabel = input.sessionLabels?.[sid] ?? sid;
    }
  }

  return {
    next,
    highDecisionsBeyondNext,
    lanes: { decide, read, waiting, flags, held },
    line: { prefix, primary, summary },
  };
}
