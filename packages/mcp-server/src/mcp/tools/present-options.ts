import { nanoid } from "nanoid";
import { validatePresentOptionsInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged } from "../tool-helpers.js";
import { scanContentForSecrets } from "../../secret-scan.js";
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
  // (A) — feed the agent's OWN named concepts into the concept↔concept lane.
  // Pre-Phase-1 `o.concept.name` was thrown away: preflight only saw the raw
  // prose (context/title/description), so a concept the agent itself named
  // ("pay-per-request hosting") was never compared short-vs-short against a
  // stored rejected/team concept.
  const proposalConcepts: string[] = proposedOptions
    .map((o) => o.concept?.name)
    .filter((n): n is string => Boolean(n && n.trim()));
  const pre = await ctx.helpers.preflightRejectedApproaches("present_options", proposals, [], proposalConcepts);
  if (!pre.ok) return pre.response;

  const id = `art_${nanoid(10)}`;
  const decisionId = `dec_${nanoid(10)}`;
  const content = { context, options: proposedOptions, decisionId, stakes };
  // #160 — decisions were a scanner GAP: option descriptions/pros/cons quote
  // sample configs ("with key sk-…") exactly like findings evidence does. Scan
  // BEFORE creation so matches PERSIST (labels+location only — never the
  // value); the #158 banner and check_feedback consumers then work for free.
  const secretMatches = scanContentForSecrets(content);
  const artifact = await ctx.store.createArtifact({
    id,
    type: "decision",
    title: context,
    content,
    relatedArtifactIds: args?.relatedFindings,
    ...(secretMatches.length > 0 ? { secretWarnings: secretMatches } : {}),
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
