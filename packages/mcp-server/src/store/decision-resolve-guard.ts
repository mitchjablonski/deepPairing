import type { Artifact } from "@deeppairing/shared";
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
  | { kind: "no_record" };

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
