import { performance } from "node:perf_hooks";
import type { Artifact } from "@deeppairing/shared";
import type { IStore } from "../../store/store-interface.js";
import type { ToolState } from "./types.js";

/**
 * #533 — per-presenter feedback ownership + crash-safe, exactly-one-poller
 * delivery for check_feedback.
 *
 * ROUTING. Subagents spawned through Claude Code's Agent tool share the
 * parent's MCP connection, so they share ONE session bucket. check_feedback
 * used to drain + acknowledge every unacknowledged comment / resolved decision
 * in that bucket, so whichever agent polled next consumed the human's answer —
 * possibly a context-less sibling. An artifact now optionally records who
 * presented it (`presentedBy`), and check_feedback optionally takes a filter
 * `{ artifactIds?, presentedBy? }`. A FILTERED poll sees, reports and ACKs ONLY
 * the feedback on matching artifacts (`artifactIds` follows revisions).
 * Session-level `__session__` directives and human requests are nobody's in
 * particular → they stay for the coordinator.
 *
 * RESERVATION (who an unfiltered poll leaves alone). A filtered consumer —
 * keyed by its whole filter, so a label AND an `artifactIds`-only poller are
 * both covered — is LIVE while one of its check_feedback calls is in flight,
 * or for LIVE_POLL_GRACE_MS after its last one ended (the gap between two
 * polls of a working subagent). While live, the feedback its filter matches is
 * held back from the unfiltered (coordinator) poll, which reports
 * `status: "held"` + `heldBackFor` + per-label counts instead of "proceed". A
 * consumer that stops polling (the subagent exited) stops reserving within the
 * grace window, and its leftovers — orphans — reach the coordinator. Presenting
 * alone reserves nothing: a builder that presents and exits without ever
 * polling leaves its answer to the coordinator immediately. With no filtered
 * poll in the window the unfiltered poll is byte-identical to the legacy one.
 *
 * CLAIMS (concurrent pollers). Two overlapping check_feedback calls used to
 * read the same unacknowledged item and both deliver it. Every item a poll
 * selects from a consumable lane is now CLAIMED (in memory, per store
 * instance) synchronously with the selection; a concurrent poll skips claimed
 * items. Claims are released when the poll ends — after its ACK flush on
 * success, or with nothing ACKed on a throw/cancel — so a failed poll's items
 * are visible (and re-delivered) to the very next poll.
 *
 * DELIVERY (the ACK-before-handoff loss). The handler used to ACK each lane
 * mid-assembly and THEN keep going; any throw after the first ACK (a daemon
 * 5xx on a later read, a ledger error) — or a cancelled call (the human hit
 * Esc during the 30s long-poll; the handler ran on and returned into the void)
 * — lost those items for good: acknowledged, never seen by the model. Now
 * every acknowledge* the handler makes is BUFFERED (PendingAcks) and flushed
 * only at the hand-off point, after the full response is built and only if the
 * request was not cancelled. Anything that fails before that leaves the items
 * unacknowledged, so the next poll re-delivers them with the SAME ids (comment
 * `id`, `decisionId`, status-change `id`, render failure `artifactId+visualId`).
 *
 * Why this and not "ACK on the next poll" / ack tokens: a next-poll confirm
 * cannot tell a dead turn from a live one either (the next poll arrives in a
 * NEW turn and would confirm content that turn never saw), it leaves delivered
 * items unacknowledged between polls (so a sibling poll — or the unfiltered
 * coordinator — would see and double-process them, and the UI's unread state
 * lags), and an explicit token is unusable by every existing agent that never
 * echoes one. Deferring the ACK to the hand-off point is the smallest change
 * that closes every in-process loss window, keeps legacy callers and payloads
 * byte-identical, and never double-delivers a confirmed item. Residual
 * (documented, not closed): the process dying in the microseconds between the
 * flush and the stdio write. Delivery is therefore AT-LEAST-ONCE: an agent that
 * sees an id it already acted on should skip it.
 */

/** A filtered consumer stays live (its feedback reserved from unfiltered
 *  polls) for this long after its last check_feedback call ended. Long enough
 *  to span a working subagent's gap between polls; short enough that an
 *  exited subagent's leftovers reach the coordinator within a minute. */
export const LIVE_POLL_GRACE_MS = 60 * 1000;

export interface FeedbackFilter {
  artifactIds?: string[];
  presentedBy?: string;
}

/** The optional `{artifactIds?, presentedBy?}` filter, or null for the legacy
 *  unfiltered poll (absent / empty / malformed → null, never a throw). */
export function parseFeedbackFilter(args: unknown): FeedbackFilter | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const filter: FeedbackFilter = {};
  if (typeof a.presentedBy === "string" && a.presentedBy.trim()) {
    filter.presentedBy = a.presentedBy.trim().slice(0, 80);
  }
  if (Array.isArray(a.artifactIds)) {
    const ids = a.artifactIds.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (ids.length > 0) filter.artifactIds = ids;
  }
  return filter.presentedBy || filter.artifactIds ? filter : null;
}

/** Stable per-consumer key: filtered pollers keep their own report-once state. */
export function consumerKey(filter: FeedbackFilter): string {
  if (filter.presentedBy && !filter.artifactIds) return `by:${filter.presentedBy}`;
  return JSON.stringify({ by: filter.presentedBy ?? null, ids: [...(filter.artifactIds ?? [])].sort() });
}

/** Human-facing name of a consumer, for the held-back note. */
export function consumerLabel(filter: FeedbackFilter): string {
  if (filter.presentedBy) return filter.presentedBy;
  return `artifacts ${(filter.artifactIds ?? []).join(", ")}`;
}

export interface LiveConsumer {
  filter: FeedbackFilter;
  /** check_feedback calls with this filter currently in flight. */
  inflight: number;
  /** Epoch ms the last call with this filter started or ended. */
  lastAt: number;
}

export function beginConsumer(state: ToolState, filter: FeedbackFilter, now = Date.now()): string {
  const key = consumerKey(filter);
  state.liveConsumers ??= {};
  const c = (state.liveConsumers[key] ??= { filter, inflight: 0, lastAt: now });
  c.inflight++;
  c.lastAt = now;
  return key;
}

export function endConsumer(state: ToolState, key: string, now = Date.now()): void {
  const c = state.liveConsumers?.[key];
  if (!c) return;
  c.inflight = Math.max(0, c.inflight - 1);
  c.lastAt = now;
}

export interface Reservation {
  label: string;
  filter: FeedbackFilter;
  /** null while a poll is in flight; else ms until the grace window lapses. */
  releaseInMs: number | null;
}

/** The live filtered consumers whose feedback an unfiltered poll leaves
 *  alone. Empty for every legacy (filter-free) session. */
export function liveReservations(state: ToolState, now = Date.now()): Reservation[] {
  const out: Reservation[] = [];
  for (const c of Object.values(state.liveConsumers ?? {})) {
    const since = now - c.lastAt;
    if (c.inflight > 0) out.push({ label: consumerLabel(c.filter), filter: c.filter, releaseInMs: null });
    else if (since <= LIVE_POLL_GRACE_MS) {
      out.push({ label: consumerLabel(c.filter), filter: c.filter, releaseInMs: LIVE_POLL_GRACE_MS - since });
    }
  }
  return out;
}

/** Acknowledgements buffered until the hand-off point. */
export class PendingAcks {
  comments: string[] = [];
  decisions: string[] = [];
  statusChanges: string[] = [];
  renderFailures: Array<{ artifactId: string; visualId: string }> = [];
  /** #569 pilot task A — worker-stop ids to mark delivered. */
  workerStops: string[] = [];

  /** Flush every lane; a failing lane does not stop the others. Returns the
   *  errors (an un-flushed lane simply re-delivers next poll). */
  async flush(store: IStore): Promise<unknown[]> {
    const errors: unknown[] = [];
    const run = async (fn: () => unknown) => {
      try {
        await fn();
      } catch (err) {
        errors.push(err);
      }
    };
    if (this.comments.length > 0) await run(() => store.acknowledgeComments(this.comments));
    if (this.decisions.length > 0) await run(() => store.acknowledgeDecisions(this.decisions));
    if (this.statusChanges.length > 0) await run(() => store.acknowledgeStatusChanges(this.statusChanges));
    if (this.renderFailures.length > 0) await run(() => store.acknowledgeRenderFailures?.(this.renderFailures));
    if (this.workerStops.length > 0) await run(() => store.markWorkerStopsDelivered?.(this.workerStops));
    return errors;
  }
}

/** Does `a` match the filter (directly, or as a revision descendant of a
 *  listed id — a subagent that revised v1 still owns v2)? */
function matchesFilter(a: Artifact, byId: Record<string, Artifact>, filter: FeedbackFilter): boolean {
  if (filter.presentedBy && a.presentedBy !== filter.presentedBy) return false;
  if (filter.artifactIds) {
    const wanted = new Set(filter.artifactIds);
    let cur: Artifact | undefined = a;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (wanted.has(cur.id)) return true;
      seen.add(cur.id);
      cur = cur.parentId ? byId[cur.parentId] : undefined;
    }
    return false;
  }
  return true;
}

type Lane = "comments" | "decisions" | "statusChanges" | "renderFailures";

/** Per held-back consumer label: the ids it kept from this poll, by lane. */
export type HeldTally = Record<string, Record<Lane, Set<string>>>;

/** In-memory claims, per underlying store instance: item key → owning poll. */
const claimsByStore = new WeakMap<object, Map<string, symbol>>();

export interface FeedbackViewOptions {
  /** Filtered poll: only matching artifacts' feedback. */
  filter: FeedbackFilter | null;
  /** Unfiltered poll: live consumers whose feedback is held back. */
  reservations: Reservation[];
  /** Buffer acknowledgements here instead of writing them (null = write through). */
  pending: PendingAcks | null;
}

export interface FeedbackView {
  store: IStore;
  /** What the reservations held back from this poll. */
  held: HeldTally;
  /** Drop this poll's claims (call once, when the poll ends however it ends). */
  release(): void;
}

/**
 * A view of the store for one feedback-consuming call: the consumable read
 * lanes are scoped to the consumer's artifacts (filtered poll) or exclude live
 * consumers' artifacts (unfiltered poll with reservations), every selected
 * item is claimed against concurrent polls, and the acknowledge* writes are
 * buffered. With no filter and no reservation the reads pass straight through
 * (same count, same content when no other poll is in flight), so the legacy
 * call stays byte-identical (golden-parity + read-amplification pins).
 */
export function feedbackStoreView(store: IStore, opts: FeedbackViewOptions): FeedbackView {
  const { filter, reservations, pending } = opts;
  const scoping = filter !== null || reservations.length > 0;
  const token = Symbol("check_feedback poll");
  let claims = claimsByStore.get(store as object);
  if (!claims) {
    claims = new Map();
    claimsByStore.set(store as object, claims);
  }
  const claimTable = claims;
  const mine: string[] = [];
  const held: HeldTally = {};

  // Read fresh every time (no snapshot cache): the post-wake reads must see
  // the statuses the human changed during the long-poll. Only the scoping
  // paths pay for these extra reads; the legacy path makes none.
  const allArtifacts = async (): Promise<Artifact[]> => (await store.getArtifacts()) ?? [];
  /** → null when the item is this consumer's, else the label holding it
   *  ("" = simply not ours, nobody to report). */
  const ownership = async (): Promise<(artifactId: string | undefined) => string | null> => {
    const arts = await allArtifacts();
    const byId: Record<string, Artifact> = {};
    for (const a of arts) byId[a.id] = a;
    return (artifactId) => {
      const a = artifactId ? byId[artifactId] : undefined;
      if (filter) return a !== undefined && matchesFilter(a, byId, filter) ? null : "";
      if (!a) return null;
      for (const r of reservations) if (matchesFilter(a, byId, r.filter)) return r.label;
      return null;
    };
  };

  const consumable = <T>(
    lane: Lane,
    read: () => unknown,
    artifactOf: (x: T) => string | undefined,
    idOf: (x: T) => string,
    claim: boolean,
  ) => async (): Promise<T[]> => {
    const rows = ((await read()) ?? []) as T[];
    const owner = scoping ? await ownership() : null;
    // Synchronous from here: the claim check and the claim are one step, so
    // two interleaved polls can never both take the same item.
    const out: T[] = [];
    for (const x of rows) {
      if (owner) {
        const heldBy = owner(artifactOf(x));
        if (heldBy !== null) {
          if (heldBy) {
            const t = (held[heldBy] ??= { comments: new Set(), decisions: new Set(), statusChanges: new Set(), renderFailures: new Set() });
            t[lane].add(idOf(x));
          }
          continue;
        }
      }
      const key = `${lane}:${idOf(x)}`;
      const by = claimTable.get(key);
      if (by && by !== token) continue;
      if (claim && !by) {
        claimTable.set(key, token);
        mine.push(key);
      }
      out.push(x);
    }
    return out;
  };

  const commentsLane = (claim: boolean) =>
    consumable<{ id: string; target: { artifactId: string } }>("comments", () => store.getUnacknowledgedComments(), (c) => c.target.artifactId, (c) => c.id, claim);
  const decisionsLane = (claim: boolean) =>
    consumable<{ decisionId: string; artifactId: string }>("decisions", () => store.getResolvedDecisions(), (d) => d.artifactId, (d) => d.decisionId, claim);
  const statusLane = (claim: boolean) =>
    consumable<Artifact>("statusChanges", () => store.getUnacknowledgedStatusChanges(), (a) => a.id, (a) => a.id, claim);
  const renderLane = (claim: boolean) =>
    consumable<{ artifactId: string; visualId: string }>(
      "renderFailures",
      () => store.getUnacknowledgedRenderFailures?.(),
      (f) => f.artifactId,
      (f) => `${f.artifactId}/${f.visualId}`,
      claim,
    );

  const overrides: Record<string, unknown> = {
    getUnacknowledgedComments: commentsLane(true),
    getResolvedDecisions: decisionsLane(true),
    getUnacknowledgedStatusChanges: statusLane(true),
  };
  if (typeof store.getUnacknowledgedRenderFailures === "function") {
    overrides.getUnacknowledgedRenderFailures = renderLane(true);
  }
  // #569 pilot task A — worker stops are addressed to the session's LEAD (the
  // unfiltered poll), never to a filtered subagent consumer. Claimed like the
  // other lanes so two concurrent unfiltered polls can't both deliver one.
  const workerStopsLane = (claim: boolean) => async (): Promise<{ stops: Array<{ id: string }>; notice?: string }> => {
    if (filter) return { stops: [] };
    const batch = (await store.getUndeliveredWorkerStops!()) ?? { stops: [] };
    const out: Array<{ id: string }> = [];
    for (const x of batch.stops ?? []) {
      const key = `workerStops:${x.id}`;
      const by = claimTable.get(key);
      if (by && by !== token) continue;
      if (claim && !by) {
        claimTable.set(key, token);
        mine.push(key);
      }
      out.push(x);
    }
    return batch.notice ? { stops: out, notice: batch.notice } : { stops: out };
  };
  if (typeof store.getUndeliveredWorkerStops === "function") {
    overrides.getUndeliveredWorkerStops = workerStopsLane(true);
  }
  if (pending) {
    if (typeof store.markWorkerStopsDelivered === "function") {
      overrides.markWorkerStopsDelivered = (ids: string[]) => void pending.workerStops.push(...ids);
    }
    overrides.acknowledgeComments = (ids: string[]) => void pending.comments.push(...ids);
    overrides.acknowledgeDecisions = (ids: string[]) => void pending.decisions.push(...ids);
    overrides.acknowledgeStatusChanges = (ids: string[]) => void pending.statusChanges.push(...ids);
    if (typeof store.acknowledgeRenderFailures === "function") {
      overrides.acknowledgeRenderFailures = (refs: Array<{ artifactId: string; visualId: string }>) =>
        void pending.renderFailures.push(...refs);
    }
  }
  if (scoping) {
    // A scoped long-poll wakes only for feedback THIS poll could deliver —
    // not for another consumer's (which would return an empty "waiting"
    // early). performance.now(), not Date: the deadline must hold even when a
    // test freezes the wall clock.
    const peekLanes: Array<() => Promise<unknown[]>> = [commentsLane(false), decisionsLane(false), statusLane(false)];
    if (typeof store.getUnacknowledgedRenderFailures === "function") peekLanes.push(renderLane(false));
    // #569 pilot task A — a worker stop wakes the lead's scoped wait too.
    if (!filter && typeof store.getUndeliveredWorkerStops === "function") {
      const peekStops = workerStopsLane(false);
      peekLanes.push(async () => (await peekStops()).stops);
    }
    overrides.waitForFeedback = async (timeoutMs = 30000) => {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) return;
        const started = performance.now();
        await store.waitForFeedback(Math.ceil(remaining));
        if (performance.now() >= deadline) return;
        for (const peek of peekLanes) if ((await peek()).length > 0) return;
        // Never spin on a store whose wait returns instantly.
        if (performance.now() - started < 50) await new Promise((r) => setTimeout(r, 100));
      }
    };
  }
  if (filter) {
    // A filtered poll reports on its OWN work only: the waiting lines, pending
    // counts, rejection verdicts and carried-over questions are all scoped.
    const own = <T>(read: () => unknown, artifactOf: (x: T) => string | undefined) => async (): Promise<T[]> => {
      const rows = ((await read()) ?? []) as T[];
      const owner = await ownership();
      return rows.filter((x) => owner(artifactOf(x)) === null);
    };
    overrides.getArtifacts = own<Artifact>(() => allArtifacts(), (a) => a.id);
    overrides.getPendingDecisions = own<{ artifactId: string }>(() => store.getPendingDecisions(), (d) => d.artifactId);
    overrides.getPendingPlanReviews = own<{ artifactId: string }>(() => store.getPendingPlanReviews(), (p) => p.artifactId);
    overrides.getFullState = async () => {
      const full = await store.getFullState();
      const owner = await ownership();
      return {
        ...full,
        artifacts: (full.artifacts ?? []).filter((a) => owner(a.id) === null),
        comments: (full.comments ?? []).filter((c) => owner(c.target.artifactId) === null),
        // Human requests are addressed to the session, not to one presenter.
        requests: [],
      };
    };
  }

  const view = new Proxy(store, {
    get(target, prop, _receiver) {
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return overrides[prop];
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  return {
    store: view,
    held,
    release() {
      for (const key of mine.splice(0)) {
        if (claimTable.get(key) === token) claimTable.delete(key);
      }
    },
  };
}

/** Totals for the held-back note: "1 decision, 2 comments". */
export function describeHeld(t: Record<Lane, Set<string>>): { total: number; text: string } {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(t.decisions.size, "decision", "decisions");
  add(t.comments.size, "comment", "comments");
  add(t.statusChanges.size, "status change", "status changes");
  add(t.renderFailures.size, "render failure", "render failures");
  const total = t.decisions.size + t.comments.size + t.statusChanges.size + t.renderFailures.size;
  return { total, text: parts.join(", ") };
}
