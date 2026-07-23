import { useMemo } from "react";
import type { Artifact, Comment } from "@deeppairing/shared";
import { coerceDecisionContent } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { CommentThread } from "../CommentThread";
import { makeThreadCarryover } from "./carryover";

/**
 * #180 — the ArtifactPanel decision-comment view.
 *
 * ArtifactDetail renders a flat "Comments" thread under every artifact. For a
 * DECISION artifact that thread also shows the grain comments (whole-option +
 * option/decision sections) that carry forward across a tune via
 * useChainComments — but with only the generic "from vN" chip, hiding the richer
 * CARRIED / STALE / ORPHAN signal the workbench shows. This wraps that same
 * thread with the SHARED carryover read-model so the flat surface gets the same
 * marker (the badge subsumes the chip; see CommentThread).
 *
 * DECISION-ONLY (ArtifactDetail branches on `artifact.type === "decision"`), and
 * LAZY — the `coerceDecisionContent` (Zod) it needs stays out of the entry chunk
 * (the D6 lazy-Zod split). Every OTHER artifact type keeps the plain
 * CommentThread, byte-for-byte unchanged.
 */
export function DecisionGeneralComments({
  artifact,
  comments,
}: {
  artifact: Artifact;
  comments: Comment[];
}) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const liveOptions = useMemo(
    () => coerceDecisionContent(artifact.content).options,
    [artifact.content],
  );
  const carryoverFor = useMemo(
    () =>
      makeThreadCarryover({
        artifacts,
        comments,
        currentArtifactId: artifact.id,
        liveOptions,
      }),
    [artifacts, comments, artifact.id, liveOptions],
  );

  return <CommentThread artifactId={artifact.id} comments={comments} carryoverFor={carryoverFor} />;
}
