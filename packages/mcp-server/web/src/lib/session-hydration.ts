import type { Artifact, Comment, Request } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";

interface PersistedDecision {
  decisionId?: string;
  acknowledged?: boolean;
  response?: { optionId?: string; reasoning?: string };
  resolvedAt?: string;
}

export interface SessionHydrationState {
  artifacts?: Artifact[];
  comments?: Comment[];
  requests?: Request[];
  decisions?: PersistedDecision[];
}

/** Install one complete session snapshot into the artifact store. */
export function hydrateArtifactSession(
  state: SessionHydrationState,
  options: { focusArtifactId?: string } = {},
): void {
  const store = useArtifactStore.getState();
  store.reset();
  for (const artifact of state.artifacts ?? []) store.addArtifact(artifact);
  for (const comment of state.comments ?? []) store.addComment(comment);
  store.setRequests(state.requests ?? []);

  const acknowledged = (state.decisions ?? [])
    .filter((decision) => decision.acknowledged && decision.decisionId)
    .map((decision) => decision.decisionId as string);
  if (acknowledged.length > 0) store.markDecisionsAcknowledged(acknowledged);

  for (const decision of state.decisions ?? []) {
    if (decision.decisionId && decision.response?.optionId) {
      store.recordResolvedDecision(decision.decisionId, {
        optionId: decision.response.optionId,
        reasoning: decision.response.reasoning,
        resolvedAt: decision.resolvedAt,
      });
    }
  }

  store.restoreSelection();
  store.selectDefaultOnHydration();
  if (options.focusArtifactId) store.selectArtifact(options.focusArtifactId);
}
