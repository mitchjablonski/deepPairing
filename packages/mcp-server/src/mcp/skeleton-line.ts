import { SKELETON_VISUAL_PREFIX, isAnySkeletonVisualId, isSkeletonLiveVisualId } from "@deeppairing/shared";
import type { Artifact, PlanVisual } from "@deeppairing/shared";

/**
 * Skeleton plans, parity PR 2 — the PURE half of the skeleton code view (no
 * node:fs), so check-feedback-delivery stays a pure module. The snapshot
 * builder lives in skeleton-snapshot.ts.
 */

export { SKELETON_VISUAL_PREFIX };

export const skeletonVisualId = (relPath: string): string => `${SKELETON_VISUAL_PREFIX}${relPath}`;
/** Either server snapshot kind: approved (`skelcode:`) or live (`skelcode-live:`). */
export const isSkeletonVisualId = (id: unknown): boolean => isAnySkeletonVisualId(id);

/** Drop every snapshot visual (`skelcode:` id) and any `skeleton` field from a
 *  visuals array — the server's snapshot step is the only author of either. */
export function stripSkeletonVisuals(visuals: unknown): unknown[] | undefined {
  if (!Array.isArray(visuals)) return undefined;
  return visuals
    .filter((v) => !(v && typeof v === "object" && isSkeletonVisualId((v as { id?: unknown }).id)))
    .map((v) => {
      if (!v || typeof v !== "object" || !("skeleton" in (v as object))) return v;
      const { skeleton: _forged, ...rest } = v as Record<string, unknown>;
      return rest;
    });
}

const hasForged = (visuals: unknown): boolean =>
  Array.isArray(visuals) &&
  visuals.some((v) => v && typeof v === "object" && (isSkeletonVisualId((v as { id?: unknown }).id) || "skeleton" in (v as object)));

/**
 * #607 review M2 — strip server-only skeleton metadata from AGENT content of
 * any artifact type: top-level `visuals` and every decision option's
 * `visuals`. Deterministic and pure, so it is safe inside the stance-admission
 * snapshot (the same input always yields the same digest). Content with
 * nothing to strip comes back as the SAME object.
 */
export function stripForgedSkeleton<T>(content: T): T {
  if (!content || typeof content !== "object" || Array.isArray(content)) return content;
  const c = content as Record<string, unknown>;
  const topForged = hasForged(c.visuals);
  const options = Array.isArray(c.options) ? (c.options as unknown[]) : null;
  const optForged = !!options?.some((o) => o && typeof o === "object" && hasForged((o as { visuals?: unknown }).visuals));
  if (!topForged && !optForged) return content;
  const out: Record<string, unknown> = { ...c };
  if (topForged) out.visuals = stripSkeletonVisuals(c.visuals);
  if (optForged && options) {
    out.options = options.map((o) =>
      o && typeof o === "object" && hasForged((o as { visuals?: unknown }).visuals)
        ? { ...(o as Record<string, unknown>), visuals: stripSkeletonVisuals((o as { visuals?: unknown }).visuals) }
        : o,
    );
  }
  return out as T;
}

/** The snapshot a comment says it was written on (CommentTarget.skeletonAnchor). */
export interface SkeletonLineAnchor {
  snapshot?: "approved" | "live";
  takenAt?: string;
  readAt?: number;
  fenceId?: string;
  lineText?: string;
}

const quoteLine = (text: string): string => {
  const t = text.trim().replace(/\s+/g, " ");
  return JSON.stringify(t.length > 120 ? `${t.slice(0, 117)}...` : t);
};

/**
 * check_feedback — place a line comment on a skeleton snapshot: its fence and
 * step, and WHICH snapshot it was written on (#609 review M2):
 *   " (inside the SKEL[2] fence, step 3 — pending) — on the approved skeleton"
 *   " (inside the SKEL[2] fence, step 3 — active) — on the live view as of <t>"
 * The approved snapshot never changes, so its line is exact. The live view is
 * re-read in place, so a live comment is resolved against what the comment
 * recorded at the time (fence + line text) and, when the code was re-read
 * since, says so and quotes the line as it read. Null when the comment isn't
 * on a snapshot visual.
 */
export function describeSkeletonLine(
  art: Artifact | undefined,
  visualId: unknown,
  line: unknown,
  anchor?: SkeletonLineAnchor | null,
  createdAt?: string,
): string | null {
  if (!art || art.type !== "plan" || !isSkeletonVisualId(visualId) || typeof line !== "number") return null;
  const content = art.content as { steps?: Array<{ skelId?: string; status?: string }>; visuals?: PlanVisual[] } | null;
  const visual = content?.visuals?.find((v) => v?.id === visualId);
  const live = isSkeletonLiveVisualId(visualId);
  const fences = Array.isArray(visual?.skeleton?.fences) ? visual!.skeleton!.fences : null;
  if (!fences && !anchor) return null;

  // Which fence: the one the comment recorded (live text may have moved), else
  // the one under the line in the stored snapshot.
  const anchored = anchor && typeof anchor.fenceId === "string" ? anchor.fenceId : undefined;
  const fenceId = anchor ? anchored : fences?.find((f) => line >= f.openLine && line <= f.closeLine)?.id;
  let where: string;
  if (!fenceId) {
    where = " (skeleton code, outside any fence — a structural line)";
  } else {
    const stepIndex = (content?.steps ?? []).findIndex((s) => s?.skelId === fenceId);
    const fence = fences?.find((f) => f.id === fenceId);
    const status =
      stepIndex >= 0 && content!.steps![stepIndex]!.status === "in_progress" ? "active" : fence?.status === "filled" ? "filled" : "pending";
    where = ` (inside the SKEL[${fenceId}] fence${stepIndex >= 0 ? `, step ${stepIndex + 1}` : ""} — ${status})`;
  }

  if (!live) return `${where} — on the approved skeleton`;
  // "As of" = when that live view was read (else when its text last changed,
  // else when the comment was made).
  const readIso = typeof anchor?.readAt === "number" && Number.isFinite(anchor.readAt) ? new Date(Math.floor(anchor.readAt)).toISOString() : undefined;
  const asOf = readIso ?? anchor?.takenAt ?? createdAt;
  const currentTakenAt = visual?.skeleton?.takenAt;
  const movedSince = anchor
    ? !!currentTakenAt && currentTakenAt !== anchor.takenAt
    : !!currentTakenAt && !!createdAt && createdAt < currentTakenAt;
  const changed = movedSince || !visual
    ? `; the code has changed since, so this line may have moved${anchor?.lineText !== undefined ? ` — when commented it read ${quoteLine(anchor.lineText)}` : ""}`
    : "";
  return `${where} — on the live view${asOf ? ` as of ${asOf}` : ""}${changed}`;
}

/**
 * Parity PR 3 — where the checklist and the code disagree, read from the
 * code: a step marked done whose fence still holds SKEL_TODO, or a pending
 * step whose fences are all filled. `skipIds` are steps another warning in the
 * same reply already names (#606's "done with SKEL_TODO" check).
 */
export function skeletonProgressMismatches(
  steps: Array<{ skelId?: string; status?: string }>,
  fences: Array<{ id: string; file: string; openLine: number; status: "todo" | "filled" }>,
  skipIds: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  steps.forEach((st, i) => {
    const id = st?.skelId;
    if (typeof id !== "string" || !id || skipIds.has(id)) return;
    const mine = fences.filter((f) => f.id === id);
    if (mine.length === 0) return;
    const todo = mine.filter((f) => f.status === "todo");
    if (st.status === "done" && todo.length > 0) {
      out.push(`step ${i + 1} (SKEL[${id}]) is marked done, but SKEL_TODO is still in the code at ${todo.map((f) => `${f.file}:${f.openLine}`).join(", ")}`);
    } else if ((st.status === undefined || st.status === "pending") && todo.length === 0) {
      out.push(`step ${i + 1} (SKEL[${id}]) is still pending, but its fence is already filled in the code — mark it done, or say why not`);
    }
  });
  return out;
}
