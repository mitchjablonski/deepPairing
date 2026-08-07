import { nanoid } from "nanoid";
import { validatePresentOptionsInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, hashPresentArgs, buildDedupResponse } from "../tool-helpers.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handlePresentOptions(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validatePresentOptionsInput(args);
  if (!validated.ok) return validated.error;
  const { context, options: validatedOptions, stakes } = validated.data;
  // M1.1 — the short fork-naming title (already trimmed/capped by the input
  // schema). When present it becomes the artifact/session title, the card
  // header, and the whole-card-reject ledger key; `context` keeps the full
  // background. Absent → everything falls back to context exactly as before.
  const title = validated.data.title;
  const artifactTitle = title ?? context;
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

  // N2 (#226) — short-window de-dup: an identical present_options still in
  // draft returns the existing decision artifact instead of minting a twin.
  // F4 — surface the existing artifact's decisionId (from its stored content)
  // alongside the artifactId so the agent can resolve the dedup'd decision too.
  const dedup = await ctx.helpers.beginPresentIdempotency("present_options", hashPresentArgs(args));
  if (dedup.duplicate) {
    const dupArt = (await ctx.store.getArtifacts()).find((a) => a.id === dedup.duplicate!.artifactId);
    const dupDecisionId = (dupArt?.content as { decisionId?: unknown } | undefined)?.decisionId;
    return buildDedupResponse(
      dedup.duplicate,
      ctx.store.getLivePort?.() ?? ctx.port,
      typeof dupDecisionId === "string" ? { decisionId: dupDecisionId } : undefined,
    );
  }

  const id = `art_${nanoid(10)}`;
  const decisionId = `dec_${nanoid(10)}`;
  // M1.1 — spread title only when present so an absent-title artifact's content
  // is byte-identical to today (no `title: undefined` key on disk).
  const content = { context, ...(title ? { title } : {}), options: proposedOptions, decisionId, stakes };
  // #160 — decisions were a scanner GAP: option descriptions/pros/cons quote
  // sample configs ("with key sk-…") exactly like findings evidence does.
  // #162 — the scan runs INSIDE createArtifact now (parity with addComment);
  // matches PERSIST (labels+location only — never the value) and we read them
  // back for the broadcast below.
  let artifact: Awaited<ReturnType<typeof ctx.store.createArtifact>>;
  try {
    artifact = await ctx.store.createArtifact({
      id,
      type: "decision",
      title: artifactTitle,
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
  // Y1' — record the preflight trace alongside the artifact.
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_options", pre.trace);
  await ctx.store.recordDecisionRequest({
    decisionId,
    artifactId: id,
    context,
    ...(title ? { title } : {}),
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
    ...(title ? { title } : {}),
    // DV1 — broadcast the validated+id-stamped options (was args?.options, the
    // raw pre-validation input). This makes the live event match the stored
    // artifact content and carries per-option visuals to the live DecisionCard.
    options: proposedOptions,
    stakes,
  });

  // Decisions with multiple options are best reviewed in the companion UI;
  // the option comparison surface is much richer than a terminal form.
  //
  // N2 (#226 scope 3) — surface the ARTIFACT id (art_) alongside the decision
  // id (dec_). Every other present_* tool returns art_; present_options used to
  // return ONLY dec_, so an agent scraping its own reply to withdraw/revise the
  // decision had no id to pass (withdraw_artifact/revise_artifact take art_).
  // dec_ stays too — the decision-resolve flow keys on it — and it's mirrored
  // in structuredContent so strict clients don't prose-parse.
  return {
    content: [{ type: "text", text: `Decision "${args?.context}" presented to human (${decisionId}, artifact ${id}). They can select at localhost:${ctx.port}. Call check_feedback for their choice.${formatPreflightTraceSummary(pre.trace)}${await ctx.helpers.getPassiveFeedback()}` }],
    structuredContent: { artifactId: id, decisionId },
  };
}
