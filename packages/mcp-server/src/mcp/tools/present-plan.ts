import { nanoid } from "nanoid";
import { preflightArtifact } from "../artifact-preflight.js";
import { validatePresentPlanInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle, maybeUpdateTaskStatus } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge, linkServedRequest, hashPresentArgs, buildDedupResponse, formatStyleWarnings } from "../tool-helpers.js";
import { resolveProjectRoot } from "../../project-root.js";
import { scanSkeletonFences } from "../../skeleton-scope.js";
import { attachSkeletonSnapshot } from "../skeleton-snapshot.js";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * Skeleton plans — the skeleton is written BEFORE the plan is presented, so a
 * `skelId` with no fence on disk (or a fence no step claims) is a plan that
 * doesn't match the code it describes. Reported, not refused. Never throws.
 */
export function skeletonPlanNote(
  steps: Array<{ skelId?: string }>,
  // Parity PR 2 — the code-view snapshot already walked the tree; reuse it.
  scan?: ReturnType<typeof scanSkeletonFences>,
): string {
  try {
    const ids = steps.map((st) => st.skelId).filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return "";
    const root = resolveProjectRoot();
    const { fences, errors } = scan ?? scanSkeletonFences(root.worktree?.workspaceRoot ?? root.projectRoot);
    const onDisk = new Set(fences.map((f) => f.id));
    const claimed = new Set(ids);
    const missing = [...claimed].filter((id) => !onDisk.has(id));
    const unclaimed = [...onDisk].filter((id) => !claimed.has(id) && fences.some((f) => f.id === id && f.status === "todo"));
    const notes = [
      ...missing.map((id) => `step skelId "${id}" has no SKEL[${id}] fence on disk — write the skeleton before presenting it`),
      ...unclaimed.map((id) => `SKEL[${id}] is a pending fence no step claims`),
      ...errors.map((e) => `malformed SKEL markers: ${e}`),
    ];
    return notes.length > 0 ? `\n⚠ Skeleton check: ${notes.join("; ")}.` : `\nSkeleton check: ${claimed.size} fence${claimed.size === 1 ? "" : "s"} found on disk.`;
  } catch {
    return "";
  }
}

export async function handlePresentPlan(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validatePresentPlanInput(args);
  if (!validated.ok) return validated.error;
  const { title, steps: planSteps, estimatedChanges, visuals } = validated.data;
  const pre = (await preflightArtifact(ctx, "present_plan", "plan", title, validated.data))!;
  if (!pre.ok) return pre.response;

  // N2 (#226) — short-window de-dup for an identical, still-draft present_plan.
  const dedup = await ctx.helpers.beginPresentIdempotency("present_plan", hashPresentArgs(args));
  if (dedup.duplicate) return buildDedupResponse(dedup.duplicate, ctx.store.getLivePort?.() ?? ctx.port);
  // O3 (#231) — the LIVE bound port, matching buildDedupResponse. After a
  // TIME_WAIT idle-respawn the daemon may be on a new port; ctx.port is the
  // spawn-time value, so the human-facing review URL must use getLivePort.
  const reviewPort = ctx.store.getLivePort?.() ?? ctx.port;

  const id = `art_${nanoid(10)}`;
  // Skeleton plans, parity PR 2 — a plan with skelId steps carries its skeleton
  // AS CODE: the fenced (and file-map "create") files are read from disk into
  // annotated_code visuals (stable id per path) after the agent's own visuals.
  // A plan without skelId steps is the same object, byte-unchanged.
  const agentContent = { steps: planSteps, estimatedChanges, ...(visuals ? { visuals } : {}) };
  const skeleton = attachSkeletonSnapshot<Record<string, unknown>>(agentContent);
  const content = skeleton.content;
  const skeletonNote = `${skeletonPlanNote(planSteps, skeleton.scan)}${skeleton.note}`;
  // #160 — plans were a scanner GAP: step descriptions/reasoning (and visuals
  // like a prototype's source) routinely quote config blocks, exactly where a
  // pasted key hides. #162 — the scan runs INSIDE createArtifact now (parity
  // with addComment); matches PERSIST on the artifact (labels+location only —
  // never the value) and we read them back for the broadcast below.
  let artifact: Awaited<ReturnType<typeof ctx.store.createArtifact>>;
  try {
    artifact = await ctx.store.createArtifact({
      id,
      type: "plan",
      title,
      content,
      relatedArtifactIds: args?.relatedFindings,
      feature: args?.feature,
      // #533 — the presenting agent's label (check_feedback ownership filter).
      presentedBy: typeof args?.presentedBy === "string" ? args.presentedBy : undefined,
    });
  } catch (e) {
    dedup.abort?.();
    throw e;
  }
  dedup.commit?.(id);
  const secretMatches = artifact.secretWarnings ?? [];
  await ctx.store.recordPlanReview(id);
  // AA6.3 — trace before broadcast so the breadcrumb is populated on
  // first paint (see present-findings.ts for the full rationale).
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_plan", pre.trace);
  ctx.broadcast({ type: "artifact_created", artifact });
  if (secretMatches.length > 0) {
    ctx.broadcast({
      type: "secret_warning",
      artifactId: artifact.id,
      patterns: secretMatches.map((m) => m.pattern),
      labels: secretMatches.map((m) => m.label),
    });
  }
  notifyResourcesListChanged(ctx.server);
  await maybeEmitTaskHandle(ctx.server, artifact, ctx.store);
  ctx.broadcast({ type: "plan_review_request", artifactId: id, title });

  // Try elicitation for quick approval.
  const elicitAction = await ctx.helpers.tryElicit(
    `Plan: "${args?.title}" (${args?.steps?.length ?? 0} steps)\n\n` +
    `Accept to approve this plan.\n` +
    `Decline to review steps in detail at http://localhost:${reviewPort}`,
  );
  const traceSummary = formatPreflightTraceSummary(pre.trace);
  // Steer re-posts toward revise_artifact: if a live plan with a similar title
  // already exists, this is probably a revision that should supersede it.
  const nudge = await revisionNudge(ctx.store, "plan", title, id);
  // G1 (#198b) — link a served request if the agent named one.
  const servedNote = await linkServedRequest(ctx.store, args, artifact.id);
  if (elicitAction === "approve") {
    await ctx.store.updateArtifactStatus(id, "approved", "elicit_accept");
    await maybeUpdateTaskStatus(ctx.server, id, ctx.store);
    await ctx.store.resolvePlanReview(id, "approved");
    return {
      content: [{ type: "text", text: `Plan "${args?.title}" approved (${id}). Proceed with implementation.${servedNote}${traceSummary}${nudge}${formatStyleWarnings(artifact.type, agentContent)}${skeletonNote}${await ctx.helpers.getPassiveFeedback()}` }],
    };
  }

  return {
    content: [{ type: "text", text: `Plan "${args?.title}" presented for review (${id}). Human can approve/revise/reject at localhost:${reviewPort}. Call check_feedback for their verdict.${servedNote}${traceSummary}${nudge}${formatStyleWarnings(artifact.type, agentContent)}${skeletonNote}${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
