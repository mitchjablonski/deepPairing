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
  const c = artifact.content as { steps?: Array<{ status?: string }>; tasks?: Array<{ status?: string }> };
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
    revised: `revised — progress belongs on the latest version of this ${kind}; use its id`,
  };
  const warning = NOT_EXECUTABLE[artifact.status]
    ? `\n⚠ WARNING: this ${kind} is ${NOT_EXECUTABLE[artifact.status]}.`
    : "";
  return {
    content: [{
      type: "text",
      text: `${isSpec ? "Spec" : "Plan"} progress recorded: ${done}/${items.length} ${unit} complete. The companion UI checklist is live — keep marking ${unit} as you finish them.${warning}`,
    }],
  };
}
