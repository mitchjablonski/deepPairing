import { useMemo } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useReplayStore } from "../stores/replay";
import { orderedPendingArtifacts } from "../lib/attention";
import { REVIEWABLE_TYPES } from "../lib/pending";

/** A verdict was recorded: approved (incl. a resolved decision, which flips to
 *  approved), sent back (revised), rejected, or dismissed (obsolete). Drafts,
 *  informational artifacts, superseded and retracted versions are not receipts. */
const VERDICT_STATUSES = new Set(["approved", "revised", "rejected", "obsolete"]);
export function isVerdictReceipt(a: Artifact): boolean {
  return REVIEWABLE_TYPES.has(a.type) && VERDICT_STATUSES.has(a.status);
}

/**
 * #642 item 7 — after a verdict only the changeset moved you on; a plan,
 * finding, code change or decision left you on the resolved item with no
 * pointer to what's next. On a verdict receipt (see isVerdictReceipt), when
 * something else is waiting, name the head of the canonical pending queue (the
 * same Decide projection the banner chips and `n` use).
 *
 * A link, never an auto-jump: focus and the receipt stay put until you click.
 * Hidden during replay (a historical frame has no live queue to walk).
 */
export function NextPendingLink({ artifact }: { artifact: Artifact }) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  // #650 — an explicit open: when an agent filter is on and the queue head
  // belongs to another agent, the filter follows it atomically (raw selection
  // would leave the target hidden by the filter).
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const replayActive = useReplayStore((s) => s.active);
  const queue = useMemo(() => orderedPendingArtifacts(artifacts), [artifacts]);
  if (replayActive) return null;
  // Sol P2 — receipt-local only: shown on an artifact that received a verdict,
  // never on an unreviewed informational draft or a historical version.
  if (!isVerdictReceipt(artifact)) return null;
  if (queue.some((a) => a.id === artifact.id)) return null; // defensive: still needs you
  const next = queue[0];
  if (!next) return null;
  const more = queue.length - 1;
  return (
    <button
      type="button"
      data-next-pending
      onClick={() => openArtifact(next.id)}
      className="ml-auto shrink-0 max-w-[45%] truncate px-2 py-0.5 text-2xs text-accent-blue rounded hover:bg-surface-hover transition-colors"
      title={more > 0 ? `${next.title} (${more} more waiting)` : next.title}
      aria-label={`Next waiting for you: ${next.title}${more > 0 ? `, ${more} more after it` : ""}`}
    >
      Next: {next.title} →
    </button>
  );
}
