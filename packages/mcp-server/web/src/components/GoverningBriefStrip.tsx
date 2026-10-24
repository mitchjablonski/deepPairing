import { useMemo } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { selectGoverningBrief } from "../lib/governingBrief";

/**
 * #571 slice 2 — the pinned GOVERNING BRIEF strip. While a delegated run
 * proceeds, the approved brief (the spec that governs it) stays one glance and
 * one click away: title + version, objective, live task progress (#578), the
 * edge-path count (#582) and the `Review:` mode.
 *
 * Read-only navigation. It derives everything from the store (so the live WS
 * paths it rides — plan_progress_updated, artifact_created/updated on a
 * supersede — need no new wiring), adds no attention lane, badge or gate, and
 * its one action only selects the brief. It sits above the sidebar/detail row,
 * clear of the composer; at narrow widths it wraps rather than scrolls.
 */
export function GoverningBriefStrip({ artifacts }: { artifacts: Artifact[] }) {
  const all = useArtifactStore((s) => s.artifacts);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const brief = useMemo(() => selectGoverningBrief(artifacts, all), [artifacts, all]);
  if (!brief) return null;

  const open = () => {
    selectArtifact(brief.id);
    // Bring the brief's detail pane into view once it has rendered. Optional
    // chains throughout: jsdom has no scrollIntoView / rAF guarantees.
    const scroll = () => {
      const el = document.querySelector(`[data-artifact-id="${brief.id.replace(/["\\]/g, "\\$&")}"]`) as HTMLElement | null;
      el?.scrollTo?.({ top: 0 });
      el?.scrollIntoView?.({ block: "nearest" });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
    else scroll();
  };

  const t = brief.tasks;
  const progress = t
    ? t.tracked
      ? `${t.done}/${t.total} task${t.total === 1 ? "" : "s"} done${t.skipped > 0 ? ` · ${t.skipped} skipped` : ""}`
      : `${t.total} task${t.total === 1 ? "" : "s"}`
    : undefined;

  return (
    <section
      aria-label="Governing brief"
      data-testid="governing-brief-strip"
      className="shrink-0 border-b border-border-default bg-surface-secondary px-2 py-1"
    >
      <button
        type="button"
        onClick={open}
        data-testid="governing-brief-open"
        title="Open the governing brief"
        className="w-full min-w-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-1.5 py-1 text-left cursor-pointer hover:bg-surface-elevated focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue"
      >
        <span className="shrink-0 text-2xs font-semibold uppercase tracking-wide text-text-secondary">
          Governing brief
        </span>
        <span className="min-w-0 max-w-full truncate text-xs font-medium text-text-primary" data-testid="governing-brief-title">
          {brief.title}
        </span>
        {brief.version > 1 && (
          <span className="shrink-0 text-2xs font-medium text-text-secondary" data-testid="governing-brief-version">
            v{brief.version}
          </span>
        )}
        {brief.awaitingApproval && (
          <span className="shrink-0 text-2xs font-medium text-accent-amber" data-testid="governing-brief-awaiting">
            {brief.version > 1 ? "revised, awaiting approval" : "awaiting approval"}
          </span>
        )}
        {brief.objective && (
          <span
            className="min-w-0 flex-1 basis-40 truncate text-xs text-text-secondary"
            data-testid="governing-brief-objective"
          >
            {brief.objective}
          </span>
        )}
        <span className="ml-auto flex shrink-0 flex-wrap items-baseline gap-x-2 text-2xs text-text-secondary">
          {progress && <span data-testid="governing-brief-progress">{progress}</span>}
          {brief.edgePathCount !== undefined && (
            <span data-testid="governing-brief-edge-paths">
              {brief.edgePathCount} edge path{brief.edgePathCount === 1 ? "" : "s"}
            </span>
          )}
          {brief.reviewMode && (
            <span data-testid="governing-brief-review">Review: {brief.reviewMode}</span>
          )}
        </span>
      </button>
    </section>
  );
}
