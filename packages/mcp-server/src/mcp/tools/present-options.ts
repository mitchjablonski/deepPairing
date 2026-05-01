import { nanoid } from "nanoid";
import { validatePresentOptionsInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace } from "../tool-helpers.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handlePresentOptions(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validatePresentOptionsInput(args);
  if (!validated.ok) return validated.error;
  const { context, options: proposedOptions, stakes } = validated.data;
  const proposals: string[] = [
    context,
    ...proposedOptions.map((o) => o.title),
    ...proposedOptions.map((o) => o.description),
  ].filter(Boolean);
  const pre = await ctx.helpers.preflightRejectedApproaches("present_options", proposals);
  if (!pre.ok) return pre.response;

  const id = `art_${nanoid(10)}`;
  const decisionId = `dec_${nanoid(10)}`;
  const artifact = await ctx.store.createArtifact({
    id,
    type: "decision",
    title: context,
    content: { context, options: proposedOptions, decisionId, stakes },
    relatedArtifactIds: args?.relatedFindings,
  });
  // Y1' — record the preflight trace alongside the artifact.
  persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_options", pre.trace);
  await ctx.store.recordDecisionRequest({
    decisionId,
    artifactId: id,
    context,
    options: proposedOptions,
    stakes,
  } as any);
  ctx.broadcast({ type: "artifact_created", artifact });
  await maybeEmitTaskHandle(ctx.server, artifact, ctx.store);
  ctx.broadcast({
    type: "decision_request",
    decisionId,
    artifactId: id,
    context: args?.context,
    options: args?.options,
    stakes,
  });

  // Decisions with multiple options are best reviewed in the companion UI;
  // the option comparison surface is much richer than a terminal form.
  return {
    content: [{ type: "text", text: `Decision "${args?.context}" presented to human (${decisionId}). They can select at localhost:${ctx.port}. Call check_feedback for their choice.${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
