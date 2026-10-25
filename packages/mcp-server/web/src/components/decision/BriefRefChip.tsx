import { describeBriefPin, formatBriefPin, readBriefRef, type Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";

/**
 * #572 slice A — "Exception to <brief> vN · REQ-x" on an options card.
 *
 * Renders ONLY the declared link saved on the card (text only — ids are agent
 * text, never markup). The pin is resolved against the EXACT brief id in the
 * card's own session: no successor walk, no "current brief" lookup. Before
 * the brief hydrates (or when it's gone) the raw id shows as unavailable with
 * "version unknown"; a stored ref that can't be read shows raw, unavailable.
 * It changes nothing about pending, attention, approval or defaults.
 */
export function BriefRefChip({ artifact }: { artifact: Artifact }) {
  const read = readBriefRef(artifact.briefRef);
  const artifacts = useArtifactStore((s) => s.artifacts);
  const selectExact = useArtifactStore((s) => s.selectArtifactExact);
  if (read === undefined) return null;
  const base = "mx-3 mt-3 -mb-1 inline-flex max-w-full items-center gap-1 rounded border px-2 py-0.5 text-2xs";
  if (!read.ok) {
    return (
      <div className={`${base} border-border-default text-text-muted`} data-testid="brief-ref-chip" data-brief-state="malformed">
        <span className="truncate">Exception to {read.rawId ?? "a brief"} (link unreadable, unavailable)</span>
      </div>
    );
  }
  const view = describeBriefPin(read.ref, artifacts, artifact.sessionId);
  const text = formatBriefPin(view);
  if (!view.available) {
    return (
      <div className={`${base} border-border-default text-text-muted`} data-testid="brief-ref-chip" data-brief-state="unavailable" title={text}>
        <span className="truncate">{text}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => selectExact(read.ref.artifactId)}
      className={`${base} border-accent-violet/40 bg-accent-violet-dim/40 text-accent-violet hover:bg-accent-violet-dim press-scale`}
      data-testid="brief-ref-chip"
      data-brief-state={view.closed ? "closed" : "current"}
      title={`Open the pinned brief version (${read.ref.artifactId}). A declared link, not drift detection.`}
    >
      <span className="truncate">{text}</span>
    </button>
  );
}
