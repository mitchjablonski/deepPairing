import type { Artifact } from "@deeppairing/shared";
import type { IStore } from "./store-interface.js";
import { isCrossTerminalVerdictFlip } from "./verdict-guard.js";

/**
 * #460 / #464 review — the ONE guard both decision-resolve routes run BEFORE
 * any write (the public /api/decisions/:id and the daemon-internal
 * /decisions/:id/resolve). store.resolveDecision overwrites a recorded response
 * and records an answer on a decision closed elsewhere, so a stale card (a
 * sibling tab, an old window) could silently replace the human's real pick.
 *
 *  - a DIFFERENT pick on an answered decision, or any pick on a decision whose
 *    artifact reached a different terminal verdict → `conflict` (409
 *    verdict_already_final), carrying the recorded resolution so the stale tab
 *    can render the winning pick;
 *  - the SAME pick again → `same`: a true no-op (nothing rewritten — the agent
 *    may already have consumed `reasoning`/`resolvedAt`), answered 200 with the
 *    recorded resolution;
 *  - otherwise null: resolve normally.
 */
export interface RecordedResolution {
  optionId: string;
  reasoning?: string;
  resolvedAt?: string;
}

export type StaleResolveVerdict =
  | { kind: "conflict"; backing?: Artifact; body: Record<string, unknown> }
  | { kind: "same"; backing?: Artifact; body: Record<string, unknown> }
  | null;

export async function checkStaleResolve(
  store: Pick<IStore, "getDecision" | "getDecisionResponse" | "getArtifacts">,
  decisionId: string,
  optionId: string,
): Promise<StaleResolveVerdict> {
  const record = await store.getDecision(decisionId);
  const prior = record ? await store.getDecisionResponse(decisionId) : null;
  const backing = (await store.getArtifacts()).find(
    (a) => a.id === record?.artifactId ||
      (a.type === "decision" && ((a.content as { decisionId?: string } | null)?.decisionId === decisionId || a.id === decisionId)),
  );
  const resolution: RecordedResolution | undefined = prior
    ? { optionId: prior.optionId, ...(prior.reasoning ? { reasoning: prior.reasoning } : {}), ...(record?.resolvedAt ? { resolvedAt: record.resolvedAt } : {}) }
    : undefined;

  if (prior && prior.optionId === optionId) {
    return {
      kind: "same",
      backing,
      body: { status: "resolved", alreadyResolved: true, decisionId, ...(backing ? { artifactId: backing.id } : {}), resolution },
    };
  }
  const answeredElsewhere = !!prior;
  const closedElsewhere = !!backing && isCrossTerminalVerdictFlip(backing.status, "approved", "ui_decision_resolve");
  if (!answeredElsewhere && !closedElsewhere) return null;
  const currentStatus = backing?.status ?? "approved";
  const at = resolution?.resolvedAt ?? backing?.updatedAt;
  return {
    kind: "conflict",
    backing,
    body: {
      error: "verdict_already_final",
      code: "verdict_already_final",
      currentStatus,
      decisionId,
      ...(backing ? { artifactId: backing.id } : {}),
      ...(resolution ? { resolution } : {}),
      at,
      message: answeredElsewhere
        ? `This decision was already answered${at ? ` at ${at}` : ""} elsewhere — your pick wasn't applied; this card now shows the recorded answer.`
        : `This decision was already ${currentStatus}${at ? ` at ${at}` : ""} elsewhere — your pick wasn't applied; this card now shows its current state.`,
    },
  };
}
