import { apiGet, apiBase } from "./api";
import { useArtifactStore } from "../stores/artifact";
import { useReplayStore } from "../stores/replay";

/**
 * #138 — the ONE cross-session navigation scheme: open a past session in
 * read-only REPLAY mode, optionally landing on a specific artifact. Extracted
 * verbatim from SessionBrowser.loadSession so the project-wide DecisionsView's
 * "jump to this decision in its session" click behaves IDENTICALLY to clicking
 * a cross-session search result — no second routing scheme.
 *
 * Fetches the historical session state, resets the live artifact store, refills
 * it, seeds the agent-acknowledged decision receipts, then enters replay (the
 * ReplayScrubber above ArtifactPanel hides events after the cursor). When
 * `focusArtifactId` is given, advances the scrubber to that artifact's creation
 * event and selects it — selectArtifact resolves a superseded id to its live
 * successor, so a decision whose artifact was revised still lands on v2.
 *
 * Returns true on success, false if the session couldn't be loaded (caller can
 * surface a failure). Never throws for a non-2xx response.
 */
export async function enterSessionReplay(
  sessionId: string,
  focusArtifactId?: string,
): Promise<boolean> {
  const res = await apiGet(`${apiBase()}/api/sessions/${sessionId}`);
  if (!res.ok) return false;
  // Response.json() is typed `any`; keep it inferred (no explicit `any`
  // annotation) so the store's own types apply at each call site below.
  const state = await res.json();

  const store = useArtifactStore.getState();
  store.reset();
  for (const artifact of state.artifacts ?? []) {
    store.addArtifact(artifact);
  }
  for (const comment of state.comments ?? []) {
    store.addComment(comment);
  }
  // Re-seed agent-consumed decision receipts (reset() cleared them), so a
  // replayed decision doesn't show a permanently-false "will pick it up".
  const ackedIds: string[] = (state.decisions ?? [])
    .filter((d: { decisionId?: string; acknowledged?: boolean }) => d?.acknowledged && d?.decisionId)
    .map((d: { decisionId?: string }) => d.decisionId as string);
  if (ackedIds.length > 0) {
    store.markDecisionsAcknowledged(ackedIds);
  }

  await useReplayStore.getState().enterReplay(sessionId, state);

  if (focusArtifactId) {
    const target = (state.artifacts ?? []).find(
      (a: { id?: string; createdAt?: string }) => a.id === focusArtifactId,
    );
    if (target?.createdAt) {
      useReplayStore.getState().setCursor(target.createdAt);
      store.selectArtifact(focusArtifactId);
    }
  }
  return true;
}
