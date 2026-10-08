import type { Artifact, DecisionClosedStatus, DecisionSupersededBy } from "@deeppairing/shared";
import type { DecisionRecord } from "./store-interface.js";
import { isCrossTerminalVerdictFlip } from "./verdict-guard.js";

/**
 * #460 / #464 — the stale-resolve rules, and (#464 Astra review) the outcome of
 * the ONE atomic check-and-resolve every decision-resolve caller goes through.
 *
 * The first version (checkStaleResolve) read the record over several awaits,
 * returned a snapshot, and the route called resolveDecision separately — so two
 * overlapping requests could both see "no prior answer" and both write (the
 * second replaced the first; the first then got a false 400 "not an option").
 * Now the classification below runs INSIDE FileStore.resolveDecisionAtomic, in
 * the same synchronous critical section as the write: no await between the
 * check and `dec.response = …`, so the first writer wins and every later caller
 * sees its answer.
 *
 *  - the SAME pick again → `same`: a true no-op (nothing rewritten — the agent
 *    may already have consumed `reasoning`/`resolvedAt`) with the recorded
 *    resolution;
 *  - a DIFFERENT pick on an answered decision, or any pick on a decision whose
 *    artifact reached a different terminal verdict → `conflict`, carrying the
 *    recorded (winning) resolution;
 *  - an option the decision doesn't have → `invalid_option` (F2 fail-closed);
 *  - no decision record → `no_record` (the route's artifact-only fallback);
 *  - otherwise the store resolved it → `resolved`.
 */
export interface RecordedResolution {
  optionId: string;
  reasoning?: string;
  resolvedAt?: string;
}

/** #484 review — the winner to announce once its write is durable. */
export interface ResolutionAnnouncement {
  optionId: string;
  reasoning?: string;
  confidence?: "low" | "medium" | "high";
  predictedOutcome?: string;
  artifactId?: string;
}

export type DecisionResolveOutcome =
  | { kind: "resolved"; artifactId?: string }
  | { kind: "same"; artifactId?: string; resolution: RecordedResolution }
  | { kind: "conflict"; artifactId?: string; currentStatus: string; at?: string; resolution?: RecordedResolution }
  | { kind: "invalid_option" }
  | { kind: "no_record" }
  /** #492 — the decision's artifact is closed: refuse, write nothing. */
  | { kind: "closed"; artifactId?: string; currentStatus: DecisionClosedStatus; supersededBy?: DecisionSupersededBy };

/** The stale-resolve rule for a decision RECORD (pure; called inside the
 *  store's critical section). Null = go ahead and resolve. */
export function classifyStaleResolve(
  record: Pick<DecisionRecord, "response" | "resolvedAt">,
  backing: Artifact | undefined,
  optionId: string,
): Extract<DecisionResolveOutcome, { kind: "same" | "conflict" }> | null {
  const prior = record.response;
  const resolution: RecordedResolution | undefined = prior
    ? { optionId: prior.optionId, ...(prior.reasoning ? { reasoning: prior.reasoning } : {}), ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}) }
    : undefined;
  if (resolution && prior!.optionId === optionId) {
    return { kind: "same", ...(backing ? { artifactId: backing.id } : {}), resolution };
  }
  const closedElsewhere = !!backing && isCrossTerminalVerdictFlip(backing.status, "approved", "ui_decision_resolve");
  if (!resolution && !closedElsewhere) return null;
  return {
    kind: "conflict",
    ...(backing ? { artifactId: backing.id } : {}),
    currentStatus: backing?.status ?? "approved",
    at: resolution?.resolvedAt ?? backing?.updatedAt,
    ...(resolution ? { resolution } : {}),
  };
}

/** The HTTP body for a `same` (200) or `conflict` (409) outcome. */
export function staleResolveBody(
  outcome: Extract<DecisionResolveOutcome, { kind: "same" | "conflict" }>,
  decisionId: string,
): Record<string, unknown> {
  if (outcome.kind === "same") {
    return {
      status: "resolved", alreadyResolved: true, decisionId,
      ...(outcome.artifactId ? { artifactId: outcome.artifactId } : {}),
      resolution: outcome.resolution,
    };
  }
  const answered = !!outcome.resolution;
  const at = outcome.at;
  return {
    error: "verdict_already_final",
    code: "verdict_already_final",
    currentStatus: outcome.currentStatus,
    decisionId,
    ...(outcome.artifactId ? { artifactId: outcome.artifactId } : {}),
    ...(outcome.resolution ? { resolution: outcome.resolution } : {}),
    at,
    message: answered
      ? `This decision was already answered${at ? ` at ${at}` : ""} elsewhere — your pick wasn't applied; this card now shows the recorded answer.`
      : `This decision was already ${outcome.currentStatus}${at ? ` at ${at}` : ""} elsewhere — your pick wasn't applied; this card now shows its current state.`,
  };
}

/**
 * #464 (Astra review) — per-store serialization of a decision resolve from the
 * atomic check-and-write THROUGH its flush. The check-and-write itself is one
 * synchronous critical section; this additionally keeps a second request from
 * reading the first one's answer while that answer is still unflushed — if the
 * flush then fails (a concurrent proposal rewrite freezes the store), the
 * second request sees the same frozen store instead of a "recorded" answer
 * that never reached disk. Errors never poison the chain.
 */
const resolveChains = new WeakMap<object, Promise<unknown>>();
export function withDecisionResolveLock<T>(store: object, fn: () => Promise<T>): Promise<T> {
  const prev = resolveChains.get(store) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  resolveChains.set(store, next.catch(() => undefined));
  return next;
}


/** #492 — backing-artifact statuses that close a decision to new answers. */
export const CLOSED_DECISION_STATUSES: ReadonlySet<string> = new Set(["superseded", "retracted", "obsolete"]);

/**
 * #492 — the closed-decision rule (pure; called inside the store's critical
 * section AFTER the stale-resolve rule, so an identical re-pick of a recorded
 * answer stays a no-op and a different pick on an answered one stays the 409
 * with the winner). A closed, unanswered decision refuses any new answer; for a
 * superseded one it names the newest version so the card can link to it.
 */
export function classifyClosedDecision(
  backing: Artifact | undefined,
  artifacts: Artifact[],
): Extract<DecisionResolveOutcome, { kind: "closed" }> | null {
  if (!backing || !CLOSED_DECISION_STATUSES.has(backing.status)) return null;
  const outcome: Extract<DecisionResolveOutcome, { kind: "closed" }> = {
    kind: "closed",
    artifactId: backing.id,
    currentStatus: backing.status as DecisionClosedStatus,
  };
  if (backing.status === "superseded") {
    // Follow the version chain (parentId) to the newest successor.
    let current = backing;
    const seen = new Set<string>([backing.id]);
    for (;;) {
      const next = artifacts.find((a) => a.parentId === current.id && !seen.has(a.id));
      if (!next) break;
      seen.add(next.id);
      current = next;
    }
    if (current !== backing) {
      const decisionId = (current.content as { decisionId?: unknown } | null)?.decisionId;
      outcome.supersededBy = { artifactId: current.id, ...(typeof decisionId === "string" && decisionId ? { decisionId } : {}) };
    }
  }
  return outcome;
}

/** #492 — the HTTP body for a `closed` outcome (409 decision_closed). */
export function closedResolveBody(
  outcome: Extract<DecisionResolveOutcome, { kind: "closed" }>,
  decisionId: string,
): Record<string, unknown> {
  const message = outcome.currentStatus === "superseded"
    ? "This question was revised — answer the new version. Your answer to the old one wasn't recorded."
    : outcome.currentStatus === "retracted"
      ? "Claude withdrew this question, so your answer wasn't recorded."
      : "This question was closed — it was overtaken by new information, so your answer wasn't recorded.";
  return {
    error: "decision_closed",
    code: "decision_closed",
    currentStatus: outcome.currentStatus,
    decisionId,
    ...(outcome.artifactId ? { artifactId: outcome.artifactId } : {}),
    ...(outcome.supersededBy ? { supersededBy: outcome.supersededBy } : {}),
    message,
  };
}
