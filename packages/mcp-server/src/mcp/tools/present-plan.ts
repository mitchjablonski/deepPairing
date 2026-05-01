import { nanoid } from "nanoid";
import { validatePresentPlanInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle, maybeUpdateTaskStatus } from "../tasks-probe.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handlePresentPlan(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validatePresentPlanInput(args);
  if (!validated.ok) return validated.error;
  const { title, steps: planSteps, estimatedChanges } = validated.data;
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
  const blocked = await ctx.helpers.preflightRejectedApproaches("present_plan", proposals, proposalPaths);
  if (blocked) return blocked;

  const id = `art_${nanoid(10)}`;
  const artifact = await ctx.store.createArtifact({
    id,
    type: "plan",
    title,
    content: { steps: planSteps, estimatedChanges },
    relatedArtifactIds: args?.relatedFindings,
  });
  await ctx.store.recordPlanReview(id);
  ctx.broadcast({ type: "artifact_created", artifact });
  await maybeEmitTaskHandle(ctx.server, artifact, ctx.store);
  ctx.broadcast({ type: "plan_review_request", artifactId: id, title });

  // Try elicitation for quick approval.
  const elicitAction = await ctx.helpers.tryElicit(
    `Plan: "${args?.title}" (${args?.steps?.length ?? 0} steps)\n\n` +
    `Accept to approve this plan.\n` +
    `Decline to review steps in detail at http://localhost:${ctx.port}`,
  );
  if (elicitAction === "approve") {
    await ctx.store.updateArtifactStatus(id, "approved", "elicit_accept");
    await maybeUpdateTaskStatus(ctx.server, id, ctx.store);
    await ctx.store.resolvePlanReview(id, "approved");
    return {
      content: [{ type: "text", text: `Plan "${args?.title}" approved (${id}). Proceed with implementation.${await ctx.helpers.getPassiveFeedback()}` }],
    };
  }

  return {
    content: [{ type: "text", text: `Plan "${args?.title}" presented for review (${id}). Human can approve/revise/reject at localhost:${ctx.port}. Call check_feedback for their verdict.${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
