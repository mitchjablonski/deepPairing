import { nanoid } from "nanoid";
import { validateLogReasoningInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handleLogReasoning(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validateLogReasoningInput(args);
  if (!validated.ok) return validated.error;
  const id = `art_${nanoid(10)}`;
  const relatedIds = args?.relatesTo?.artifactId ? [args.relatesTo.artifactId] : undefined;
  const artifact = await ctx.store.createArtifact({
    id,
    type: "reasoning",
    title: args?.action ?? "Reasoning",
    content: {
      action: args?.action,
      reasoning: args?.reasoning,
      concept: args?.concept,
      evidence: args?.evidence,
      relatesTo: args?.relatesTo,
      alternativesConsidered: args?.alternativesConsidered ?? [],
      alternativeDetails: args?.alternativeDetails,
      confidence: args?.confidence,
    },
    agentReasoning: args?.reasoning,
    relatedArtifactIds: relatedIds,
  });
  ctx.broadcast({ type: "artifact_created", artifact });
  await maybeEmitTaskHandle(ctx.server, artifact, ctx.store);
  // Gentle nudge when the agent omits `concept` — the pairing value
  // hinges on the concept being surfaced, not the reasoning prose.
  const nudge = args?.concept?.name
    ? ""
    : "\n(Pairing nudge: name the underlying concept via `concept` so the human learns the pattern, not just the fix.)";
  return {
    content: [{ type: "text", text: `Reasoning logged. Proceed with code changes.${nudge}${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
