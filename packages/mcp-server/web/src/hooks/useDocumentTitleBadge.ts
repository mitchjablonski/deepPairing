import { useEffect } from "react";
import { useArtifactStore } from "../stores/artifact";
import { computePending } from "../lib/pending";

const BASE_TITLE = "deepPairing — Companion";

/**
 * B2 — surface the turn-handoff in the TAB TITLE. This is a companion UI: the
 * human lives in the terminal and the tab is backgrounded most of the time, so
 * "(2) Your turn — deepPairing" in the tab strip is the shoulder-tap that makes
 * the handoff land without requiring notification permission. Driven by the
 * same computePending predicate as the banner/indicator so it can't disagree.
 */
export function useDocumentTitleBadge(): void {
  // C1 — select the pending COUNT (a primitive), not the artifacts array:
  // this hook lives in the App root, and the array gets a new identity on
  // every artifact event — each one re-rendered the entire shell just to
  // (maybe) update a title string.
  const pendingCount = useArtifactStore((s) => computePending(s.artifacts).drafts.length);
  useEffect(() => {
    document.title = pendingCount > 0 ? `(${pendingCount}) Your turn — deepPairing` : BASE_TITLE;
  }, [pendingCount]);
  // Restore the base title if the app unmounts (tests, HMR).
  useEffect(() => () => {
    document.title = BASE_TITLE;
  }, []);
}
