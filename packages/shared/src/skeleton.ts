import { SKELETON_VISUAL_PREFIX } from "./schemas/content-types.js";

/**
 * Skeleton plans, parity PR 3 (#609 review) — two snapshots per fenced file:
 *   - `skelcode:<path>`      — the APPROVED snapshot: what the human reviewed
 *                              at present_plan / revise. Never rewritten.
 *   - `skelcode-live:<path>` — the LIVE progress snapshot: re-read from disk on
 *                              update_plan_progress while the plan is live.
 * Both carry `skeleton` metadata; only the server writes either.
 */
export const SKELETON_LIVE_VISUAL_PREFIX = "skelcode-live:";

export const isSkeletonApprovedVisualId = (id: unknown): boolean =>
  typeof id === "string" && id.startsWith(SKELETON_VISUAL_PREFIX);
export const isSkeletonLiveVisualId = (id: unknown): boolean =>
  typeof id === "string" && id.startsWith(SKELETON_LIVE_VISUAL_PREFIX);
/** Either snapshot kind — the ids only the server may author. */
export const isAnySkeletonVisualId = (id: unknown): boolean => isSkeletonApprovedVisualId(id) || isSkeletonLiveVisualId(id);

/** `skelcode:a.ts` → `skelcode-live:a.ts` (and back). */
export const liveVisualIdFor = (approvedId: string): string =>
  `${SKELETON_LIVE_VISUAL_PREFIX}${approvedId.slice(SKELETON_VISUAL_PREFIX.length)}`;
export const approvedVisualIdFor = (liveId: string): string =>
  `${SKELETON_VISUAL_PREFIX}${liveId.slice(SKELETON_LIVE_VISUAL_PREFIX.length)}`;

const CLOSED_FOR_PROGRESS = new Set(["superseded", "rejected", "retracted", "obsolete"]);

/**
 * #609 review M1 — a plan version is LIVE for a code re-read when it is the
 * latest in its lineage (no artifact names it as parent) and not superseded,
 * rejected, retracted or obsolete. A closed version keeps the code it was
 * reviewed with.
 */
export function isLivePlanVersion(
  art: { id: string; type: string; status: string },
  artifacts: ReadonlyArray<{ parentId?: string | null }>,
): boolean {
  if (art.type !== "plan" || CLOSED_FOR_PROGRESS.has(art.status)) return false;
  return !artifacts.some((a) => a.parentId === art.id);
}
