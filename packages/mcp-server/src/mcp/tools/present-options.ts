import { nanoid } from "nanoid";
import { validatePresentOptionsInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged } from "../tool-helpers.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handlePresentOptions(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validatePresentOptionsInput(args);
  if (!validated.ok) return validated.error;
  const { context, options: validatedOptions, stakes } = validated.data;
  // DV1 — stamp stable option-scoped ids on any per-option visuals the agent
  // sent id-less, so the stored content AND the broadcast event carry the same
  // canonical shape (and future comment threads anchor consistently). Mirrors
  // coerceOption's fallback so a write and a later coerced read agree.
  const proposedOptions = validatedOptions.map((o) =>
    o.visuals?.length
      ? { ...o, visuals: o.visuals.map((v, i) => ({ ...v, id: v.id ?? `${o.id}_visual_${i}` })) }
      : o,
  );
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
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_options", pre.trace);
  await ctx.store.recordDecisionRequest({
    decisionId,
    artifactId: id,
    context,
    options: proposedOptions,
    stakes,
  } as any);
  ctx.broadcast({ type: "artifact_created", artifact });
  notifyResourcesListChanged(ctx.server);
  await maybeEmitTaskHandle(ctx.server, artifact, ctx.store);
  ctx.broadcast({
    type: "decision_request",
    decisionId,
    artifactId: id,
    context,
    // DV1 — broadcast the validated+id-stamped options (was args?.options, the
    // raw pre-validation input). This makes the live event match the stored
    // artifact content and carries per-option visuals to the live DecisionCard.
    options: proposedOptions,
    stakes,
  });

  // Decisions with multiple options are best reviewed in the companion UI;
  // the option comparison surface is much richer than a terminal form.
  return {
    content: [{ type: "text", text: `Decision "${args?.context}" presented to human (${decisionId}). They can select at localhost:${ctx.port}. Call check_feedback for their choice.${formatPreflightTraceSummary(pre.trace)}${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
