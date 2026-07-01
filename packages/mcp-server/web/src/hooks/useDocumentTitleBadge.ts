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
  const artifacts = useArtifactStore((s) => s.artifacts);
  useEffect(() => {
    const n = computePending(artifacts).drafts.length;
    document.title = n > 0 ? `(${n}) Your turn — deepPairing` : BASE_TITLE;
  }, [artifacts]);
  // Restore the base title if the app unmounts (tests, HMR).
  useEffect(() => () => {
    document.title = BASE_TITLE;
  }, []);
}
