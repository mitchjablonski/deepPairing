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

/** Parity PR 3 — the checklist vs the code, read from the code. */
export function fenceMismatch(fence: SkeletonFenceView, steps: SkeletonStepLike[] | undefined): string | null {
  const owner = (steps ?? []).find((s) => s?.skelId === fence.id);
  if (!owner) return null;
  if (owner.status === "done" && fence.status === "todo") return "Marked done, but SKEL_TODO is still in the code";
  if ((owner.status === undefined || owner.status === "pending") && fence.status === "filled") return "Filled in the code, but the step isn't marked done";
  return null;
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
    const mismatch = fenceMismatch(fence, steps);
    return {
      className: `${s.row}${marker ? " opacity-80" : ""}`,
      attrs: { "data-skel-fence": fence.id, "data-skel-status": status, ...(mismatch ? { "data-skel-mismatch": "true" } : {}) },
      header:
        lineNum === fence.openLine ? (
          <div
            role="note"
            className={`flex flex-wrap items-center gap-1.5 px-2 py-0.5 font-sans text-2xs ${s.row}`}
            aria-label={`SKEL[${fence.id}] fence, ${stepText}, ${s.label}${mismatch ? `. ${mismatch}` : ""}`}
          >
            <span aria-hidden="true">{s.glyph}</span>
            <span className={`rounded px-1 font-mono ${s.chip}`}>SKEL[{fence.id}]</span>
            <span className="font-medium text-text-primary">{s.label}</span>
            <span className="text-text-muted truncate">
              · {stepText}
              {owner?.step.description ? `: ${owner.step.description}` : fence.title ? `: ${fence.title}` : ""}
            </span>
            {mismatch && <span className="font-medium text-accent-red">⚠ {mismatch}</span>}
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

// --- parity PR 3: the plan-wide view of every fence, for the diagram -------

export type StepNodeState = {
  /** The step's skelId (dots and dashes intact). */
  skelId: string;
  status: FenceStatus | "unknown";
  label: string;
  /** Step number (1-based) and description, for the text cue. */
  stepNumber: number;
  description?: string;
  mismatch?: string;
  /** Where to scroll: the first fence of this id in the code view. */
  target?: { filePath: string; line: number };
};

const STATUS_RANK: Record<FenceStatus, number> = { active: 3, pending: 2, filled: 1 };

/**
 * One state per skelId step, read from the plan's `skelcode:` snapshots (the
 * code) plus live step status. A step whose fence isn't in the code view
 * (capped, skipped, protected) is "unknown", never guessed.
 */
export function planStepNodeStates(visuals: PlanVisual[], steps: SkeletonStepLike[] | undefined): Record<string, StepNodeState> {
  const out: Record<string, StepNodeState> = {};
  const snaps = visuals.filter((v) => v?.kind === "annotated_code" && v.skeleton && Array.isArray(v.skeleton.fences));
  (steps ?? []).forEach((st, i) => {
    const id = st?.skelId;
    if (typeof id !== "string" || !id || out[id]) return;
    let status: FenceStatus | "unknown" = "unknown";
    let target: StepNodeState["target"];
    let mismatch: string | undefined;
    for (const v of snaps) {
      for (const f of v.skeleton!.fences) {
        if (f.id !== id) continue;
        const fs = fenceStatus(f, steps);
        if (status === "unknown" || STATUS_RANK[fs] > STATUS_RANK[status]) status = fs;
        if (!target && typeof v.filePath === "string" && !v.skeleton!.withheld) target = { filePath: v.filePath, line: f.openLine };
        mismatch = mismatch ?? fenceMismatch(f, steps) ?? undefined;
      }
    }
    out[id] = {
      skelId: id,
      status,
      label: status === "unknown" ? "Not in the code view" : STATUS_STYLE[status].label,
      stepNumber: i + 1,
      ...(st.description ? { description: st.description } : {}),
      ...(mismatch ? { mismatch } : {}),
      ...(target ? { target } : {}),
    };
  });
  return out;
}

export const STEP_GLYPH: Record<FenceStatus | "unknown", string> = {
  pending: STATUS_STYLE.pending.glyph,
  filled: STATUS_STYLE.filled.glyph,
  active: STATUS_STYLE.active.glyph,
  unknown: "?",
};

const attrValue = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Scroll the code view to a fence's opening line. False when it isn't on screen. */
export function jumpToFence(target: { filePath: string; line: number } | undefined, root: ParentNode = document): boolean {
  if (!target) return false;
  const el = root.querySelector(`[data-comment-anchor="line:${attrValue(target.filePath)}:${target.line}"]`) as HTMLElement | null;
  if (!el) return false;
  el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  return true;
}
