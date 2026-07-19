import { nanoid } from "nanoid";
import { validateLogReasoningInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { notifyResourcesListChanged } from "../tool-helpers.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handleLogReasoning(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validateLogReasoningInput(args);
  if (!validated.ok) return validated.error;
  const id = `art_${nanoid(10)}`;
  const relatedIds = args?.relatesTo?.artifactId ? [args.relatesTo.artifactId] : undefined;
  const content = {
    action: args?.action,
    reasoning: args?.reasoning,
    concept: args?.concept,
    evidence: args?.evidence,
    relatesTo: args?.relatesTo,
    alternativesConsidered: args?.alternativesConsidered ?? [],
    alternativeDetails: args?.alternativeDetails,
    confidence: args?.confidence,
  };
  // #160 — reasoning was a scanner GAP. log_reasoning creates a REAL artifact
  // (type "reasoning"), so the "cheapest honest surface" is the same
  // artifact-level warning every other present_* path persists: the reasoning
  // card renders through ArtifactDetail, whose #158 banner reads
  // artifact.secretWarnings. Labels+location only — never the value.
  // #162 — the scan runs INSIDE createArtifact (parity with addComment); we
  // read the matches back off the returned artifact for the broadcast below.
  const artifact = await ctx.store.createArtifact({
    id,
    type: "reasoning",
    title: args?.action ?? "Reasoning",
    content,
    agentReasoning: args?.reasoning,
    relatedArtifactIds: relatedIds,
  });
  const secretMatches = artifact.secretWarnings ?? [];
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
  // Gentle nudge when the agent omits `concept` — the pairing value
  // hinges on the concept being surfaced, not the reasoning prose.
  const nudge = args?.concept?.name
    ? ""
    : "\n(Pairing nudge: name the underlying concept via `concept` so the human learns the pattern, not just the fix.)";
  return {
    content: [{ type: "text", text: `Reasoning logged. Proceed with code changes.${nudge}${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
