import { resolveProjectRoot } from "../../project-root.js";
import { planDeclaredFiles, readSkeletonScopeFile, scanSkeletonFences, writeSkeletonScope } from "../../skeleton-scope.js";
import { isLivePlanVersion } from "@deeppairing/shared";
import { nanoid } from "nanoid";
import { resnapshotSkeleton } from "../skeleton-snapshot.js";
import { allSkeletonStepsDone, formatLeftovers, skeletonLeftovers } from "../skeleton-finalize.js";
import { skeletonProgressMismatches } from "../skeleton-line.js";
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

  // Skeleton plans, parity PR 3 — progress read from the code: re-read the
  // plan's fenced files (present_plan's bounds + allowlist) so the code view
  // and diagram follow the fills. Non-skeleton plans and specs skip this.
  // #609 review — only a LIVE plan version is re-read (the store enforces the
  // same rule under its write); a closed version keeps the code it was
  // reviewed with. The result lands in `skelcode-live:` visuals; the approved
  // `skelcode:` snapshot is never rewritten.
  const all = await store.getArtifacts();
  const before = all.find((a) => a.id === artifactId);
  // #608 (a) — the step statuses BEFORE this call (the store mutates in place),
  // to see a fence lifted without the step being done.
  const priorStatuses = ((before?.content as { steps?: Array<{ status?: string; skelId?: string }> } | undefined)?.steps ?? []).map((st) => ({
    status: st?.status,
    skelId: st?.skelId,
  }));
  const resnap = before && isLivePlanVersion(before, all) ? resnapshotSkeleton(before.content) : null;
  const artifact = resnap
    ? await store.updatePlanProgress(artifactId, updates, { skeletonVisuals: resnap.visuals, ...(resnap.readAt !== undefined ? { skeletonReadAt: resnap.readAt } : {}) })
    : await store.updatePlanProgress(artifactId, updates);
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
  // #609 review L3 — one scan per call: the re-read's scan feeds the fence check.
  const skeletonNote = isSpec ? "" : syncSkeletonScope(store.getSessionId(), artifact, updates, resnap?.scan);
  // Parity PR 3 — the checklist vs the code. Steps finished in THIS call are
  // already named by syncSkeletonScope's own "still has SKEL_TODO" check.
  let mismatchNote = "";
  if (resnap?.scan && c.steps) {
    const finishedNow = new Set(
      updates.filter((u) => u.status === "done").map((u) => c.steps?.[u.stepIndex]?.skelId).filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    const lines = skeletonProgressMismatches(c.steps, resnap.scan.fences, finishedNow);
    if (lines.length > 0) mismatchNote = `\n⚠ The checklist and the code disagree: ${lines.join("; ")}.`;
  }
  // #608 (a) — a skeleton step that leaves `in_progress` without `done` lifts
  // its own fence. Not refused (the human may have asked for it), but never
  // silent: a notice on the plan in the companion, and a line to the agent.
  let liftedNote = "";
  if (!isSpec) {
    const lifted = updates
      // #610 review L2 — `skipped` is a legitimate, often human-asked exit.
      .filter((u) => u.status === "pending")
      .filter((u) => priorStatuses[u.stepIndex]?.status === "in_progress" && typeof priorStatuses[u.stepIndex]?.skelId === "string")
      .map((u) => ({ index: u.stepIndex, skelId: priorStatuses[u.stepIndex]!.skelId!, status: u.status }));
    if (lifted.length > 0) {
      const what = lifted.map((l) => `SKEL[${l.skelId}] (step ${l.index + 1}, now ${l.status})`).join(", ");
      try {
        await store.addComment({
          id: `cmt_${nanoid(10)}`,
          artifactId: artifact.id,
          author: "agent",
          content: `Fence lifted without completing the step: ${what}. Edits outside the skeleton are no longer gated for ${lifted.length === 1 ? "it" : "them"}. If this is a skeleton change, it should come to you as a revised plan.`,
        });
      } catch {
        /* the notice is best-effort; the reply below still says it */
      }
      liftedNote = `\n⚠ Fence lifted without done: ${what}. Your pair sees a notice on the plan. If you need a structural change, propose it and revise_artifact the plan (reason "Skeleton change: …") instead.`;
    }
  }
  // Parity PR 4 — reshape: a skeleton plan's newer version waits for approval
  // before fills resume.
  const isSkeleton = !isSpec && (c.steps ?? []).some((st) => typeof st.skelId === "string" && st.skelId);
  const reshapeNote = isSkeleton && artifact.status === "draft" && artifact.parentId
    ? "\nThis is a reshaped skeleton awaiting re-review: fills are paused. Until your pair approves it, the preflight hook asks before any edit to this plan's files."
    : "";
  // Parity PR 4 — the finalize check once the last skeleton step is done.
  let finalizeNote = "";
  if (isSkeleton && artifact.status === "approved" && allSkeletonStepsDone(artifact.content) && updates.some((u) => u.status === "done" || u.status === "skipped")) {
    const root = resolveProjectRoot();
    const found = skeletonLeftovers(root.worktree?.workspaceRoot ?? root.projectRoot, artifact.content);
    finalizeNote = formatLeftovers(artifact.title, found) ||
      "\nEvery skeleton step is done and no SKEL markers remain: present the whole change with present_changeset next.";
  }
  return {
    content: [{
      type: "text",
      text: `${isSpec ? "Spec" : "Plan"} progress recorded: ${done}/${items.length} ${unit} complete. The companion UI checklist is live — keep marking ${unit} as you finish them.${warning}${skeletonNote}${mismatchNote}${liftedNote}${reshapeNote}${finalizeNote}`,
    }],
  };
}

/**
 * Skeleton plans — the plan's in_progress `skelId` steps become the preflight
 * hook's fence: .deeppairing/skeleton-scopes/<artifactId>.json at the canonical
 * root the hook reads, stamped with the owning session and working tree. Only
 * an APPROVED plan opens a fence (#606 review); progress on a draft, rejected or
 * revised plan removes its own file and touches no other plan's. A step marked
 * done is checked against the plan's declared files: a fence still holding
 * SKEL_TODO, or no fence at all, is reported. Plans without skelId steps are
 * untouched. Never throws.
 */
function syncSkeletonScope(
  sessionId: string,
  artifact: { id: string; title: string; status: string; content: unknown },
  updates: Array<{ stepIndex: number; status: string }>,
  scan?: ReturnType<typeof scanSkeletonFences>,
): string {
  try {
    const content = (artifact.content ?? {}) as { steps?: Array<{ status?: string; skelId?: string; files?: unknown }>; visuals?: Array<{ kind?: unknown; files?: unknown }> };
    const steps = content.steps ?? [];
    if (!steps.some((st) => typeof st.skelId === "string" && st.skelId)) return "";
    const root = resolveProjectRoot();
    const workspaceRoot = root.worktree?.workspaceRoot ?? root.projectRoot;
    const approved = artifact.status === "approved";
    const activeSkelIds = approved ? steps.filter((st) => st.skelId && st.status === "in_progress").map((st) => st.skelId!) : [];
    // Parity PR 4 (#610 M1) — a reshape scope keeps its pause/restore block;
    // progress on the new version never silently lifts it.
    const reshape = readSkeletonScopeFile(root.projectRoot, artifact.id)?.reshape;
    writeSkeletonScope(root.projectRoot, { artifactId: artifact.id, planTitle: artifact.title, activeSkelIds, updatedAt: new Date().toISOString(), sessionId, workspaceRoot, ...(reshape ? { reshape } : {}) });

    const finished = updates
      .filter((u) => u.status === "done")
      .map((u) => steps[u.stepIndex]?.skelId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const notes: string[] = [];
    if (finished.length > 0) {
      // Fences live in the working tree (a linked worktree's own files), not
      // the canonical root the scope file is keyed to.
      const { fences } = scan ?? scanSkeletonFences(workspaceRoot, { files: planDeclaredFiles(content) });
      for (const id of finished) {
        const mine = fences.filter((f) => f.id === id);
        const todo = mine.filter((f) => f.status === "todo");
        if (mine.length === 0) notes.push(`SKEL[${id}] has no fence in the plan's files — was it removed, or is its file missing from the plan?`);
        else if (todo.length > 0) notes.push(`SKEL[${id}] still has SKEL_TODO at ${todo.map((f) => `${f.file}:${f.openLine}`).join(", ")} — finish it before marking the step done.`);
      }
    }
    const fenced = activeSkelIds.length > 0
      ? `\nSkeleton fence active: edits are gated to ${activeSkelIds.map((id) => `SKEL[${id}]`).join(", ")} until the step is done. A structural change (new helper, signature, file) is a skeleton change — propose it, don't route around the fence.`
      : !approved && steps.some((st) => st.skelId && st.status === "in_progress")
        ? "\nSkeleton fence NOT opened: this plan isn't approved."
        : "";
    return fenced + (notes.length > 0 ? `\n⚠ ${notes.join("\n⚠ ")}` : "");
  } catch {
    return "";
  }
}
