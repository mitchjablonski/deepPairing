import { useMemo } from "react";
import type { Artifact } from "@deeppairing/shared";
import { coercePageContent } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { computePageVersionDiff, summarizePageDiff, type PageDiffSummary, type PageVersionDiff } from "../lib/pageVersionDiff";

export interface PageVersionChanges {
  parent: Artifact;
  diff: PageVersionDiff;
  summary: PageDiffSummary;
}

/**
 * #714 gap 2 — what changed in this `page` version since its predecessor:
 * null for a first version, a non-page, or a predecessor not in the store.
 * Both versions are parsed with DOMParser (inert; nothing runs) and diffed in
 * the companion; the result is memoized so the page header and RevisionDiff
 * share one computation.
 */
export function usePageVersionDiff(artifact: Artifact): PageVersionChanges | null {
  const parent = useArtifactStore((s) =>
    artifact.type === "page" && artifact.parentId ? s.artifacts.find((a) => a.id === artifact.parentId) : undefined,
  );
  const oldHtml = parent?.type === "page" ? coercePageContent(parent.content).html : null;
  const newHtml = artifact.type === "page" ? coercePageContent(artifact.content).html : null;
  return useMemo(() => {
    if (!parent || oldHtml === null || newHtml === null) return null;
    const diff = computePageVersionDiff(oldHtml, newHtml);
    if (!diff) return null;
    return { parent, diff, summary: summarizePageDiff(diff) };
  }, [parent, oldHtml, newHtml]);
}
