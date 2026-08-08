import { nanoid } from "nanoid";
import { validatePresentPlanInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle, maybeUpdateTaskStatus } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge, linkServedRequest, hashPresentArgs, buildDedupResponse } from "../tool-helpers.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handlePresentPlan(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validatePresentPlanInput(args);
  if (!validated.ok) return validated.error;
  const { title, steps: planSteps, estimatedChanges, visuals } = validated.data;
  const proposals: string[] = [
    title,
    ...planSteps.map((s) => s.description),
    ...planSteps.map((s) => s.reasoning),
    ...planSteps.flatMap((s) =>
      Array.isArray((s as any).files)
        ? (s as any).files.map((f: any) => String(typeof f === "string" ? f : f?.filePath ?? ""))
        : [],
    ),
  ].filter(Boolean);
  const proposalPaths: string[] = planSteps.flatMap((s) =>
    Array.isArray((s as any).files)
      ? (s as any).files.map((f: any) => (typeof f === "string" ? f : f?.filePath)).filter(Boolean)
      : [],
  );
  const pre = await ctx.helpers.preflightRejectedApproaches("present_plan", proposals, proposalPaths);
  if (!pre.ok) return pre.response;

  // N2 (#226) — short-window de-dup for an identical, still-draft present_plan.
  const dedup = await ctx.helpers.beginPresentIdempotency("present_plan", hashPresentArgs(args));
  if (dedup.duplicate) return buildDedupResponse(dedup.duplicate, ctx.store.getLivePort?.() ?? ctx.port);
  // O3 (#231) — the LIVE bound port, matching buildDedupResponse. After a
  // TIME_WAIT idle-respawn the daemon may be on a new port; ctx.port is the
  // spawn-time value, so the human-facing review URL must use getLivePort.
  const reviewPort = ctx.store.getLivePort?.() ?? ctx.port;

  const id = `art_${nanoid(10)}`;
  const content = { steps: planSteps, estimatedChanges, ...(visuals ? { visuals } : {}) };
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
      content: [{ type: "text", text: `Plan "${args?.title}" approved (${id}). Proceed with implementation.${servedNote}${traceSummary}${nudge}${await ctx.helpers.getPassiveFeedback()}` }],
    };
  }

  return {
    content: [{ type: "text", text: `Plan "${args?.title}" presented for review (${id}). Human can approve/revise/reject at localhost:${reviewPort}. Call check_feedback for their verdict.${servedNote}${traceSummary}${nudge}${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
