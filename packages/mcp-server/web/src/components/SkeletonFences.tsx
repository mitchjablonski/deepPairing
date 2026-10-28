import type { PlanVisual, SkeletonFenceView } from "@deeppairing/shared";
import type { CodeLineDecoration } from "./CommentableCode";

/**
 * Skeleton plans, parity PR 2 — fence shading for the plan card's skeleton
 * code (the server's `skelcode:<path>` annotated_code snapshots).
 *
 * Status per fence, the standalone skeleton-skills review's three states:
 *   - pending — the body still holds SKEL_TODO (from the snapshot)
 *   - filled  — no SKEL_TODO left (from the snapshot)
 *   - active  — the step claiming the fence is `in_progress` (LIVE, from the
 *               plan's own step status, so it follows update_plan_progress)
 *
 * Accessible: each fence opens with a text strip naming the fence, its step
 * and its status, and the status is also a distinct border PATTERN (dashed /
 * solid / double) and glyph, so it never rests on colour alone.
 */

export type SkeletonStepLike = { skelId?: string; status?: string; description?: string };
export type FenceStatus = "pending" | "filled" | "active";

const STATUS_STYLE: Record<FenceStatus, { glyph: string; label: string; row: string; chip: string }> = {
  pending: {
    glyph: "○",
    label: "Pending",
    row: "border-l-2 border-dashed border-accent-amber bg-accent-amber-dim/10",
    chip: "text-accent-amber bg-accent-amber-dim",
  },
  filled: {
    glyph: "●",
    label: "Filled",
    row: "border-l-2 border-solid border-accent-green bg-accent-green-dim/10",
    chip: "text-accent-green bg-accent-green-dim",
  },
  active: {
    glyph: "▶",
    label: "Active",
    row: "border-l-4 border-double border-accent-blue bg-accent-blue-dim/20",
    chip: "text-accent-blue bg-accent-blue-dim",
  },
};

export function fenceStatus(fence: SkeletonFenceView, steps: SkeletonStepLike[] | undefined): FenceStatus {
  if ((steps ?? []).some((s) => s?.skelId === fence.id && s.status === "in_progress")) return "active";
  return fence.status === "filled" ? "filled" : "pending";
}

function stepFor(fence: SkeletonFenceView, steps: SkeletonStepLike[] | undefined): { index: number; step: SkeletonStepLike } | null {
  const list = steps ?? [];
  const index = list.findIndex((s) => s?.skelId === fence.id);
  return index >= 0 ? { index, step: list[index]! } : null;
}

/** The per-line decorator CommentableCode takes, or undefined for an ordinary visual. */
export function skeletonLineDecoration(
  visual: PlanVisual,
  steps: SkeletonStepLike[] | undefined,
): ((lineNum: number) => CodeLineDecoration | undefined) | undefined {
  const fences = Array.isArray(visual.skeleton?.fences) ? visual.skeleton!.fences : [];
  if (fences.length === 0) return undefined;
  return (lineNum) => {
    const fence = fences.find((f) => lineNum >= f.openLine && lineNum <= f.closeLine);
    if (!fence) return undefined;
    const status = fenceStatus(fence, steps);
    const s = STATUS_STYLE[status];
    const owner = stepFor(fence, steps);
    const stepText = owner ? `Step ${owner.index + 1}` : "No step claims it";
    const marker = lineNum === fence.openLine || lineNum === fence.closeLine;
    return {
      className: `${s.row}${marker ? " opacity-80" : ""}`,
      attrs: { "data-skel-fence": fence.id, "data-skel-status": status },
      header:
        lineNum === fence.openLine ? (
          <div
            role="note"
            className={`flex items-center gap-1.5 px-2 py-0.5 font-sans text-2xs ${s.row}`}
            aria-label={`SKEL[${fence.id}] fence, ${stepText}, ${s.label}`}
          >
            <span aria-hidden="true">{s.glyph}</span>
            <span className={`rounded px-1 font-mono ${s.chip}`}>SKEL[{fence.id}]</span>
            <span className="font-medium text-text-primary">{s.label}</span>
            <span className="text-text-muted truncate">
              · {stepText}
              {owner?.step.description ? `: ${owner.step.description}` : fence.title ? `: ${fence.title}` : ""}
            </span>
          </div>
        ) : undefined,
    };
  };
}

/** One compact line above the code: counts by status, plus tracked / truncated notes. */
export function SkeletonSummary({
  visual,
  steps,
  carriedComments = 0,
}: {
  visual: PlanVisual;
  steps: SkeletonStepLike[] | undefined;
  /** Line comments carried from an earlier version of this snapshot. */
  carriedComments?: number;
}) {
  const snap = visual.skeleton;
  if (!snap) return null;
  const fences = Array.isArray(snap.fences) ? snap.fences : [];
  const counts: Record<FenceStatus, number> = { pending: 0, filled: 0, active: 0 };
  for (const f of fences) counts[fenceStatus(f, steps)]++;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px] text-text-muted" data-skel-summary="true">
      {snap.tracked && <span>Tracked file, no fences</span>}
      {(Object.keys(counts) as FenceStatus[]).map((k) =>
        counts[k] > 0 ? (
          <span key={k}>
            <span aria-hidden="true">{STATUS_STYLE[k].glyph} </span>
            {counts[k]} {STATUS_STYLE[k].label.toLowerCase()}
          </span>
        ) : null,
      )}
      {snap.truncated && (
        <span className="text-accent-amber">
          Truncated: lines 1–{snap.truncated.shownLines} of {snap.truncated.totalLines}
        </span>
      )}
      {snap.markerError && <span className="text-accent-red">Malformed SKEL markers</span>}
      {carriedComments > 0 && (
        <span className="text-accent-amber" data-skel-carried="true">
          {carriedComments} line comment{carriedComments === 1 ? "" : "s"} from an earlier version: the file was re-read, so
          {carriedComments === 1 ? " it" : " they"} may have moved
        </span>
      )}
    </div>
  );
}
