import type { ToolContext, ToolResult } from "./types.js";

const VALID_STATUSES = new Set(["pending", "in_progress", "done", "skipped"]);

/**
 * D10 (H2) — update_plan_progress. After the human approves a plan, the build
 * phase was the session's longest dead-air stretch: the agent worked silently
 * until a code_change appeared. Calling this after each step keeps the plan a
 * JOINT checklist — the companion UI renders a live "Step 3 of 7" strip.
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
      content: [{ type: "text", text: `update_plan_progress: ${artifactId} is not a known plan artifact (or no update touched an existing step).` }],
      isError: true,
    };
  }

  // MCP-side broadcast is a no-op in daemon mode (the daemon route already
  // broadcast); harmless double-fire in embedded/test mode.
  broadcast({ type: "plan_progress_updated", artifact });

  const steps = (artifact.content as { steps?: Array<{ status?: string }> }).steps ?? [];
  const done = steps.filter((st) => st.status === "done" || st.status === "skipped").length;
  return {
    content: [{
      type: "text",
      text: `Plan progress recorded: ${done}/${steps.length} steps complete. The companion UI checklist is live — keep marking steps as you finish them.`,
    }],
  };
}
