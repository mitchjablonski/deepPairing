import { planDeclaredFiles, scanSkeletonFences, writeSkeletonScope } from "../skeleton-scope.js";
import { resolveProjectRoot } from "../project-root.js";

/**
 * Parity PR 4 (#610 review M1) — ENFORCE the reshape pause. A supersede of a
 * skeleton plan writes the NEW version's scope file with a `reshape` block:
 * while that version awaits approval the preflight hook asks on any edit to
 * the plans' declared and fenced files; once approved its own fences apply;
 * if it is rejected or retracted, the superseded version's in-progress fences
 * come back, but only when that version had been approved. Session- and
 * worktree-scoped exactly like #606's scopes. Never throws.
 */
export function writeReshapeScope(args: {
  sessionId: string;
  oldPlan: { id: string; status: string; content: unknown };
  newId: string;
  newTitle: string;
  newContent: unknown;
}): void {
  try {
    const oldSteps = ((args.oldPlan.content ?? {}) as { steps?: Array<{ skelId?: unknown; status?: unknown }> }).steps ?? [];
    const newSteps = ((args.newContent ?? {}) as { steps?: Array<{ skelId?: unknown }> }).steps ?? [];
    const isSkel = (steps: Array<{ skelId?: unknown }>) => steps.some((st) => typeof st?.skelId === "string" && st.skelId.length > 0);
    if (!isSkel(oldSteps) && !isSkel(newSteps)) return;
    const root = resolveProjectRoot();
    const workspaceRoot = root.worktree?.workspaceRoot ?? root.projectRoot;
    const declared = [
      ...planDeclaredFiles(args.oldPlan.content as Parameters<typeof planDeclaredFiles>[0]),
      ...planDeclaredFiles(args.newContent as Parameters<typeof planDeclaredFiles>[0]),
    ];
    // The fenced files too (a plan that declares none falls back to the walk).
    const fenced = scanSkeletonFences(workspaceRoot, { files: [...new Set(declared)] }).fences.map((f) => f.file);
    const files = [...new Set([...declared, ...fenced])];
    const restoreSkelIds = oldSteps
      .filter((st) => typeof st?.skelId === "string" && st.skelId && st.status === "in_progress")
      .map((st) => st.skelId as string);
    writeSkeletonScope(root.projectRoot, {
      artifactId: args.newId,
      planTitle: args.newTitle,
      activeSkelIds: [],
      updatedAt: new Date().toISOString(),
      sessionId: args.sessionId,
      workspaceRoot,
      reshape: { fromId: args.oldPlan.id, files, restoreApproved: args.oldPlan.status === "approved", restoreSkelIds },
    });
  } catch {
    /* fail open */
  }
}
