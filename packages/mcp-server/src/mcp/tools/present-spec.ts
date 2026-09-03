import { nanoid } from "nanoid";
import { validatePresentSpecInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle, maybeUpdateTaskStatus } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge, linkServedRequest, hashPresentArgs, buildDedupResponse, formatStyleWarnings } from "../tool-helpers.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handlePresentSpec(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validatePresentSpecInput(args);
  if (!validated.ok) return validated.error;
  const { title, objective, context, requirements, design, tasks, openQuestions, visuals } = validated.data;
  const requirementsArr = requirements;
  const tasksArr = tasks ?? [];
  const proposals: string[] = [
    title,
    objective,
    ...requirementsArr.map((r) => r.statement),
    ...requirementsArr.map((r) => r.rationale),
    ...tasksArr.map((t) => t.description),
  ].filter(Boolean);
  const pre = await ctx.helpers.preflightRejectedApproaches("present_spec", proposals);
  if (!pre.ok) return pre.response;

  // N2 (#226) — short-window de-dup for an identical, still-draft present_spec.
  const dedup = await ctx.helpers.beginPresentIdempotency("present_spec", hashPresentArgs(args));
  if (dedup.duplicate) return buildDedupResponse(dedup.duplicate, ctx.store.getLivePort?.() ?? ctx.port);
  // O3 (#231) — LIVE bound port for the human-facing review URL (getLivePort
  // survives a TIME_WAIT idle-respawn; ctx.port is the stale spawn-time value).
  const reviewPort = ctx.store.getLivePort?.() ?? ctx.port;

  const id = `art_${nanoid(10)}`;
  const content = {
    objective,
    context,
    requirements: requirementsArr,
    design,
    tasks: tasksArr,
    openQuestions: openQuestions ?? [],
    ...(visuals ? { visuals } : {}),
  };
  // #160 — specs were a scanner GAP: design/context prose quotes configs and
  // sample payloads, exactly where a pasted key hides. #162 — the scan runs
  // INSIDE createArtifact now (parity with addComment); matches PERSIST on
  // the artifact (labels+location only — never the value) and we read them
  // back for the broadcast below.
  let artifact: Awaited<ReturnType<typeof ctx.store.createArtifact>>;
  try {
    artifact = await ctx.store.createArtifact({
      id,
      type: "spec",
      title,
      content,
      feature: args?.feature,
    });
  } catch (e) {
    dedup.abort?.();
    throw e;
  }
  dedup.commit?.(id);
  const secretMatches = artifact.secretWarnings ?? [];
  // AA6.3 — trace before broadcast so the breadcrumb is populated on
  // first paint (see present-findings.ts for the full rationale).
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_spec", pre.trace);
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
  await ctx.helpers.autoNameSession(artifact.title);

  // Quick-approve path via elicitation for simple specs.
  const elicitAction = await ctx.helpers.tryElicit(
    `Spec: "${artifact.title}"\n\n` +
    `Accept to approve these requirements as-is.\n` +
    `Decline to review requirements and acceptance criteria in the companion UI at http://localhost:${reviewPort}`,
  );
  const traceSummary = formatPreflightTraceSummary(pre.trace);
  // Steer re-posts toward revise_artifact when a live spec with a similar title
  // already exists (probably a revision that should supersede it).
  const nudge = await revisionNudge(ctx.store, "spec", title, id);
  // G1 (#198b) — link a served request if the agent named one.
  const servedNote = await linkServedRequest(ctx.store, args, artifact.id);
  if (elicitAction === "approve") {
    await ctx.store.updateArtifactStatus(id, "approved", "elicit_accept");
    await maybeUpdateTaskStatus(ctx.server, id, ctx.store);
    return {
      content: [{ type: "text", text: `Spec "${artifact.title}" recorded and approved (${id}). Proceed with present_plan.${servedNote}${traceSummary}${nudge}${formatStyleWarnings(artifact.type, artifact.content)}${await ctx.helpers.getPassiveFeedback()}` }],
    };
  }

  return {
    content: [{ type: "text", text: `Spec "${artifact.title}" presented for review (${id}). The human can challenge each requirement and acceptance criterion at localhost:${reviewPort}. Call check_feedback for their response.${servedNote}${traceSummary}${nudge}${formatStyleWarnings(artifact.type, artifact.content)}${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
