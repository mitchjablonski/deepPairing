import type { Artifact } from "@deeppairing/shared";
import type { IStore } from "../../store/store-interface.js";
import type { ToolState } from "./types.js";

/**
 * #533 — per-presenter feedback ownership + crash-safe delivery for
 * check_feedback.
 *
 * ROUTING. Subagents spawned through Claude Code's Agent tool share the
 * parent's MCP connection, so they share ONE session bucket. check_feedback
 * used to drain + acknowledge every unacknowledged comment / resolved decision
 * in that bucket, so whichever agent polled next consumed the human's answer —
 * possibly a context-less sibling. An artifact now optionally records who
 * presented it (`presentedBy`), and check_feedback optionally takes a filter
 * `{ artifactIds?, presentedBy? }`. A FILTERED poll sees, reports and ACKs ONLY
 * the feedback on matching artifacts (session-level `__session__` directives
 * and human requests are nobody's in particular → they stay for the
 * coordinator). An UNFILTERED poll is byte-identical to before, with ONE
 * addition that only exists once labels are in use: feedback on an artifact
 * whose presenter label was active (presented or polled with that label)
 * within PRESENTER_LIVE_WINDOW_MS is RESERVED for that presenter. Once the
 * label goes quiet (the subagent exited) the reservation lapses and its
 * leftovers — orphans — fall through to the coordinator's unfiltered poll.
 * Labels that never polled with a filter still reserve only for the window
 * after their last present_*, so an un-polling subagent can strand nothing for
 * longer than the window.
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

/** A presenter label counts as live (its feedback is reserved for it) for this
 *  long after it last presented or polled with that label. */
export const PRESENTER_LIVE_WINDOW_MS = 5 * 60 * 1000;

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

export function notePresenterActivity(state: ToolState, label: unknown, now = Date.now()): void {
  if (typeof label !== "string" || !label.trim()) return;
  state.presenterLastSeen ??= {};
  state.presenterLastSeen[label.trim().slice(0, 80)] = now;
}

/** Labels active within the window — their feedback is held back from an
 *  unfiltered poll. Empty for every legacy (label-free) session. */
export function livePresenters(state: ToolState, now = Date.now(), exclude?: string): Set<string> {
  const live = new Set<string>();
  for (const [label, at] of Object.entries(state.presenterLastSeen ?? {})) {
    if (label !== exclude && now - at <= PRESENTER_LIVE_WINDOW_MS) live.add(label);
  }
  return live;
}

/** Acknowledgements buffered until the hand-off point. */
export class PendingAcks {
  comments: string[] = [];
  decisions: string[] = [];
  statusChanges: string[] = [];
  renderFailures: Array<{ artifactId: string; visualId: string }> = [];

  get empty(): boolean {
    return (
      this.comments.length === 0 &&
      this.decisions.length === 0 &&
      this.statusChanges.length === 0 &&
      this.renderFailures.length === 0
    );
  }

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
    return errors;
  }
}

/** Is `id` inside the filter's artifact set (directly, or as a revision
 *  descendant of a listed id — a subagent that revised v1 still owns v2)? */
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

export interface FeedbackViewOptions {
  /** Filtered poll: only matching artifacts' feedback. */
  filter: FeedbackFilter | null;
  /** Unfiltered poll: presenter labels whose feedback is reserved. */
  reserved: Set<string>;
  /** Buffer acknowledgements here instead of writing them (null = write through). */
  pending: PendingAcks | null;
  /** Records the reserved labels that actually held something back. */
  heldBackFor?: Set<string>;
}

/**
 * A view of the store for one check_feedback call: the read lanes are scoped
 * to the consumer's artifacts (filtered poll) or exclude live presenters'
 * artifacts (unfiltered poll with reservations), and the acknowledge* writes
 * are buffered. With no filter and no reservation every read passes straight
 * through untouched, so the legacy call's reads are identical in count and
 * content (the O3 read-amplification and golden-parity pins hold).
 */
export function feedbackStoreView(store: IStore, opts: FeedbackViewOptions): IStore {
  const { filter, reserved, pending, heldBackFor } = opts;
  const scoping = filter !== null || reserved.size > 0;

  // Read fresh every time (no snapshot cache): the post-wake reads must see
  // the statuses the human changed during the long-poll. Only the scoping
  // paths pay for these extra reads; the legacy path makes none.
  const allArtifacts = async (): Promise<Artifact[]> => (await store.getArtifacts()) ?? [];
  const owns = async (): Promise<(artifactId: string | undefined) => boolean> => {
    const arts = await allArtifacts();
    const byId: Record<string, Artifact> = {};
    for (const a of arts) byId[a.id] = a;
    return (artifactId) => {
      const a = artifactId ? byId[artifactId] : undefined;
      if (filter) return a !== undefined && matchesFilter(a, byId, filter);
      // Unfiltered: everything except a live presenter's reserved work.
      if (a?.presentedBy && reserved.has(a.presentedBy)) {
        heldBackFor?.add(a.presentedBy);
        return false;
      }
      return true;
    };
  };
  const scoped = <T>(read: () => unknown, key: (x: T) => string | undefined) => async (): Promise<T[]> => {
    const rows = ((await read()) ?? []) as T[];
    const keep = await owns();
    return rows.filter((x) => keep(key(x)));
  };

  const overrides: Record<string, unknown> = {};
  if (pending) {
    overrides.acknowledgeComments = (ids: string[]) => void pending.comments.push(...ids);
    overrides.acknowledgeDecisions = (ids: string[]) => void pending.decisions.push(...ids);
    overrides.acknowledgeStatusChanges = (ids: string[]) => void pending.statusChanges.push(...ids);
    if (typeof store.acknowledgeRenderFailures === "function") {
      overrides.acknowledgeRenderFailures = (refs: Array<{ artifactId: string; visualId: string }>) =>
        void pending.renderFailures.push(...refs);
    }
  }
  if (scoping) {
    overrides.getUnacknowledgedComments = scoped<{ target: { artifactId: string } }>(
      () => store.getUnacknowledgedComments(),
      (c) => c.target.artifactId,
    );
    overrides.getResolvedDecisions = scoped<{ artifactId: string }>(() => store.getResolvedDecisions(), (d) => d.artifactId);
    overrides.getUnacknowledgedStatusChanges = scoped<Artifact>(() => store.getUnacknowledgedStatusChanges(), (a) => a.id);
    if (typeof store.getUnacknowledgedRenderFailures === "function") {
      overrides.getUnacknowledgedRenderFailures = scoped<{ artifactId: string }>(
        () => store.getUnacknowledgedRenderFailures!(),
        (f) => f.artifactId,
      );
    }
  }
  if (filter) {
    // A filtered poll reports on its OWN work only: the waiting lines, pending
    // counts, rejection verdicts and carried-over questions are all scoped.
    overrides.getArtifacts = scoped<Artifact>(() => allArtifacts(), (a) => a.id);
    overrides.getPendingDecisions = scoped<{ artifactId: string }>(() => store.getPendingDecisions(), (d) => d.artifactId);
    overrides.getPendingPlanReviews = scoped<{ artifactId: string }>(() => store.getPendingPlanReviews(), (p) => p.artifactId);
    overrides.getFullState = async () => {
      const full = await store.getFullState();
      const keep = await owns();
      return {
        ...full,
        artifacts: (full.artifacts ?? []).filter((a) => keep(a.id)),
        comments: (full.comments ?? []).filter((c) => keep(c.target.artifactId)),
        // Human requests are addressed to the session, not to one presenter.
        requests: [],
      };
    };
  }

  return new Proxy(store, {
    get(target, prop, _receiver) {
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return overrides[prop];
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
