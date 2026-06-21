import { nanoid } from "nanoid";
import { validatePresentPlanInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle, maybeUpdateTaskStatus } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge } from "../tool-helpers.js";
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

  const id = `art_${nanoid(10)}`;
  const artifact = await ctx.store.createArtifact({
    id,
    type: "plan",
    title,
    content: { steps: planSteps, estimatedChanges, ...(visuals ? { visuals } : {}) },
    relatedArtifactIds: args?.relatedFindings,
  });
  await ctx.store.recordPlanReview(id);
  // AA6.3 — trace before broadcast so the breadcrumb is populated on
  // first paint (see present-findings.ts for the full rationale).
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_plan", pre.trace);
  ctx.broadcast({ type: "artifact_created", artifact });
  notifyResourcesListChanged(ctx.server);
  await maybeEmitTaskHandle(ctx.server, artifact, ctx.store);
  ctx.broadcast({ type: "plan_review_request", artifactId: id, title });

  // Try elicitation for quick approval.
  const elicitAction = await ctx.helpers.tryElicit(
    `Plan: "${args?.title}" (${args?.steps?.length ?? 0} steps)\n\n` +
    `Accept to approve this plan.\n` +
    `Decline to review steps in detail at http://localhost:${ctx.port}`,
  );
  const traceSummary = formatPreflightTraceSummary(pre.trace);
  // Steer re-posts toward revise_artifact: if a live plan with a similar title
  // already exists, this is probably a revision that should supersede it.
  const nudge = await revisionNudge(ctx.store, "plan", title, id);
  if (elicitAction === "approve") {
    await ctx.store.updateArtifactStatus(id, "approved", "elicit_accept");
    await maybeUpdateTaskStatus(ctx.server, id, ctx.store);
    await ctx.store.resolvePlanReview(id, "approved");
    return {
      content: [{ type: "text", text: `Plan "${args?.title}" approved (${id}). Proceed with implementation.${traceSummary}${nudge}${await ctx.helpers.getPassiveFeedback()}` }],
    };
  }

  return {
    content: [{ type: "text", text: `Plan "${args?.title}" presented for review (${id}). Human can approve/revise/reject at localhost:${ctx.port}. Call check_feedback for their verdict.${traceSummary}${nudge}${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
