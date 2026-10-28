import { resolveProjectRoot } from "../../project-root.js";
import { scanSkeletonFences, writeSkeletonScope } from "../../skeleton-scope.js";
import type { ToolContext, ToolResult } from "./types.js";

const VALID_STATUSES = new Set(["pending", "in_progress", "done", "skipped"]);

/**
 * D10 (H2) — update_plan_progress. After the human approves a plan, the build
 * phase was the session's longest dead-air stretch: the agent worked silently
 * until a code_change appeared. Calling this after each step keeps the plan a
 * JOINT checklist — the companion UI renders a live "Step 3 of 7" strip.
 *
 * #569 (#507 S1) — also accepts a SPEC: its `tasks[]` track execution the same
 * way (stepIndex = task index), so a delegated brief's tasks become a live
 * checklist instead of one log_reasoning per finished task.
 */
export async function handleUpdatePlanProgress(ctx: ToolContext, args: any): Promise<ToolResult> {
  const { store, broadcast } = ctx;

  const artifactId = String(args?.artifactId ?? "").trim();
  const rawUpdates = Array.isArray(args?.updates) ? args.updates : null;
  if (!artifactId || !rawUpdates || rawUpdates.length === 0) {
    return {
      content: [{ type: "text", text: "update_plan_progress requires artifactId and a non-empty updates array." }],
      isError: true,
    };
  }
  const updates: Array<{ stepIndex: number; status: "pending" | "in_progress" | "done" | "skipped"; statusNote?: string }> = [];
  for (const u of rawUpdates) {
    const stepIndex = Number(u?.stepIndex);
    const status = String(u?.status ?? "");
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || !VALID_STATUSES.has(status)) {
      return {
        content: [{ type: "text", text: `update_plan_progress: each update needs stepIndex (int ≥ 0) and status (pending|in_progress|done|skipped); got ${JSON.stringify(u)}.` }],
        isError: true,
      };
    }
    updates.push({
      stepIndex,
      status: status as "pending" | "in_progress" | "done" | "skipped",
      ...(u?.statusNote != null ? { statusNote: String(u.statusNote) } : {}),
    });
  }

  const artifact = await store.updatePlanProgress(artifactId, updates);
  if (!artifact) {
    return {
      content: [{ type: "text", text: `update_plan_progress: ${artifactId} is not a known plan or spec artifact (or no update touched an existing plan step or spec task).` }],
      isError: true,
    };
  }

  // MCP-side broadcast is a no-op in daemon mode (the daemon route already
  // broadcast); harmless double-fire in embedded/test mode.
  broadcast({ type: "plan_progress_updated", artifact });

  const isSpec = artifact.type === "spec";
  const kind = isSpec ? "spec" : "plan";
  const unit = isSpec ? "tasks" : "steps";
  const c = artifact.content as { steps?: Array<{ status?: string; skelId?: string }>; tasks?: Array<{ status?: string }> };
  const items = (isSpec ? c.tasks : c.steps) ?? [];
  const done = items.filter((st) => st.status === "done" || st.status === "skipped").length;
  // D10 review (F2-class) — executing an unapproved/rejected plan (or spec,
  // #569) violates the protocol. Record the progress (the store already did)
  // but tell the agent loudly; the honor-rejection precedent says this must
  // not be silent.
  const NOT_EXECUTABLE: Record<string, string> = {
    draft: "still AWAITING REVIEW — get your pair's approval before executing",
    rejected: `REJECTED — do not execute it; address the feedback or present a new ${kind}`,
    retracted: "retracted",
    obsolete: "obsolete",
    superseded: `superseded — progress belongs on the latest version of this ${kind}; use its id`,
    revised: "revised — revision requested; awaiting an updated brief; do not execute this version",
  };
  const warning = NOT_EXECUTABLE[artifact.status]
    ? `\n⚠ WARNING: this ${kind} is ${NOT_EXECUTABLE[artifact.status]}.`
    : "";
  const skeletonNote = isSpec ? "" : syncSkeletonScope(store.getSessionId(), artifact.id, artifact.title, c.steps ?? [], updates);
  return {
    content: [{
      type: "text",
      text: `${isSpec ? "Spec" : "Plan"} progress recorded: ${done}/${items.length} ${unit} complete. The companion UI checklist is live — keep marking ${unit} as you finish them.${warning}${skeletonNote}`,
    }],
  };
}

/**
 * Skeleton plans — the plan's in_progress `skelId` steps become the preflight
 * hook's fence (.deeppairing/skeleton-scopes/<artifactId>.json, at the
 * canonical project root the hook reads). A step marked done is checked against the code: a fence
 * still holding SKEL_TODO, or no fence at all, is reported, not hidden.
 * Plans without skelId steps are untouched. Never throws.
 */
function syncSkeletonScope(
  sessionId: string,
  artifactId: string,
  planTitle: string,
  steps: Array<{ status?: string; skelId?: string }>,
  updates: Array<{ stepIndex: number; status: string }>,
): string {
  try {
    if (!steps.some((st) => typeof st.skelId === "string" && st.skelId)) return "";
    const root = resolveProjectRoot();
    const activeSkelIds = steps.filter((st) => st.skelId && st.status === "in_progress").map((st) => st.skelId!);
    // #606 review — this plan's OWN scope file, stamped with the session and
    // working tree that own it; no other plan's progress can touch it.
    const workspaceRoot = root.worktree?.workspaceRoot ?? root.projectRoot;
    writeSkeletonScope(root.projectRoot, { artifactId, planTitle, activeSkelIds, updatedAt: new Date().toISOString(), sessionId, workspaceRoot });

    const finished = updates
      .filter((u) => u.status === "done")
      .map((u) => steps[u.stepIndex]?.skelId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const notes: string[] = [];
    if (finished.length > 0) {
      // Fences live in the working tree (a linked worktree's own files), not
      // the canonical root the scope file is keyed to.
      const { fences } = scanSkeletonFences(workspaceRoot);
      for (const id of finished) {
        const mine = fences.filter((f) => f.id === id);
        const todo = mine.filter((f) => f.status === "todo");
        if (mine.length === 0) notes.push(`SKEL[${id}] has no fence in the working tree — was it removed or never written?`);
        else if (todo.length > 0) notes.push(`SKEL[${id}] still has SKEL_TODO at ${todo.map((f) => `${f.file}:${f.openLine}`).join(", ")} — finish it before marking the step done.`);
      }
    }
    const fenced = activeSkelIds.length > 0
      ? `\nSkeleton fence active: edits are gated to ${activeSkelIds.map((id) => `SKEL[${id}]`).join(", ")} until the step is done. A structural change (new helper, signature, file) is a skeleton change — propose it, don't route around the fence.`
      : "";
    return fenced + (notes.length > 0 ? `\n⚠ ${notes.join("\n⚠ ")}` : "");
  } catch {
    return "";
  }
}
