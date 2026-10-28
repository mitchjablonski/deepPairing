import type { Artifact, PlanVisual } from "@deeppairing/shared";

/**
 * Skeleton plans, parity PR 2 — the PURE half of the skeleton code view (no
 * node:fs), so check-feedback-delivery stays a pure module. The snapshot
 * builder lives in skeleton-snapshot.ts.
 */

/** Snapshot visuals are keyed by PATH, so a line thread survives a revise. */
export const SKELETON_VISUAL_PREFIX = "skelcode:";

export const skeletonVisualId = (relPath: string): string => `${SKELETON_VISUAL_PREFIX}${relPath}`;
export const isSkeletonVisualId = (id: unknown): boolean => typeof id === "string" && id.startsWith(SKELETON_VISUAL_PREFIX);

/**
 * check_feedback — place a line comment on a skeleton snapshot inside its
 * fence: " (inside the SKEL[2] fence, step 3 — pending)". Null when the
 * comment isn't on a snapshot visual.
 */
export function describeSkeletonLine(art: Artifact | undefined, visualId: unknown, line: unknown): string | null {
  if (!art || art.type !== "plan" || !isSkeletonVisualId(visualId) || typeof line !== "number") return null;
  const content = art.content as { steps?: Array<{ skelId?: string; status?: string }>; visuals?: PlanVisual[] } | null;
  const visual = content?.visuals?.find((v) => v?.id === visualId);
  const fences = Array.isArray(visual?.skeleton?.fences) ? visual!.skeleton!.fences : null;
  if (!fences) return null;
  const fence = fences.find((f) => line >= f.openLine && line <= f.closeLine);
  if (!fence) return " (skeleton code, outside any fence — a structural line)";
  const stepIndex = (content?.steps ?? []).findIndex((s) => s?.skelId === fence.id);
  const status = stepIndex >= 0 && content!.steps![stepIndex]!.status === "in_progress" ? "active" : fence.status === "todo" ? "pending" : "filled";
  return ` (inside the SKEL[${fence.id}] fence${stepIndex >= 0 ? `, step ${stepIndex + 1}` : ""} — ${status})`;
}
