import { useMemo } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useReplayStore } from "../stores/replay";
import { orderedPendingArtifacts } from "../lib/attention";

/**
 * #642 item 7 — after a verdict only the changeset moved you on; a plan,
 * finding, code change or decision left you on the resolved item with no
 * pointer to what's next. When the artifact on screen is NOT itself waiting on
 * you and something else is, name the head of the canonical pending queue (the
 * same Decide projection the banner chips and `n` use).
 *
 * A link, never an auto-jump: focus and the receipt stay put until you click.
 * Hidden during replay (a historical frame has no live queue to walk).
 */
export function NextPendingLink({ artifact }: { artifact: Artifact }) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const replayActive = useReplayStore((s) => s.active);
  const queue = useMemo(() => orderedPendingArtifacts(artifacts), [artifacts]);
  if (replayActive) return null;
  if (queue.some((a) => a.id === artifact.id)) return null; // this one still needs you
  const next = queue[0];
  if (!next) return null;
  const more = queue.length - 1;
  return (
    <button
      type="button"
      data-next-pending
      onClick={() => selectArtifact(next.id)}
      className="ml-auto shrink-0 max-w-[45%] truncate px-2 py-0.5 text-2xs text-accent-blue rounded hover:bg-surface-hover transition-colors"
      title={more > 0 ? `${next.title} (${more} more waiting)` : next.title}
      aria-label={`Next waiting for you: ${next.title}${more > 0 ? `, ${more} more after it` : ""}`}
    >
      Next: {next.title} →
    </button>
  );
}
