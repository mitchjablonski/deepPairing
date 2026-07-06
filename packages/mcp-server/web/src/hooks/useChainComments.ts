import { useMemo } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore, collectChainComments } from "../stores/artifact";

/**
 * Bug2 — the shared comment selector for artifact renderers. Comments are
 * bucketed per-version by `target.artifactId`; after a supersede advances the
 * view to v2, `comments[v2.id]` is empty and every comment posted on v1
 * disappears. This aggregates the whole version chain (v2 + its ancestors) on
 * the READ side so posted comments render on the new version. Memoized on the
 * artifacts + comments references so it doesn't churn downstream memos.
 */
export function useChainComments(artifactId: string): Comment[] {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const comments = useArtifactStore((s) => s.comments);
  return useMemo(
    () => collectChainComments(artifacts, comments, artifactId),
    [artifacts, comments, artifactId],
  );
}
