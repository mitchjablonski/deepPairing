import { nanoid } from "nanoid";
import { validatePresentFindingsInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle, maybeUpdateTaskStatus } from "../tasks-probe.js";
import { persistPreflightTrace } from "../tool-helpers.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handlePresentFindings(ctx: ToolContext, args: any): Promise<ToolResult> {
  // Validate at the boundary so a malformed `findings` (e.g. a string
  // instead of an array) cannot land on disk and break the renderer.
  const validated = validatePresentFindingsInput(args);
  if (!validated.ok) return validated.error;
  const findings = validated.data.findings;
  const proposals: string[] = [
    args?.title ?? "",
    validated.data.summary,
    ...findings.map((f) => f?.title ?? ""),
    ...findings.map((f) => f?.recommendation ?? ""),
  ].filter(Boolean);
  // Paths from structured evidence feed scope-aware team-pref enforcement.
  const proposalPaths: string[] = findings.flatMap((f) =>
    Array.isArray(f?.evidence)
      ? f.evidence.map((e: any) => (typeof e === "object" && e?.filePath) || "").filter(Boolean)
      : [],
  );
  const pre = await ctx.helpers.preflightRejectedApproaches("present_findings", proposals, proposalPaths);
  if (!pre.ok) return pre.response;

  const id = `art_${nanoid(10)}`;
  const artifact = await ctx.store.createArtifact({
    id,
    type: "research",
    title: args?.title ?? "Research Findings",
    content: {
      summary: validated.data.summary,
      findings: validated.data.findings,
      openQuestions: validated.data.openQuestions ?? [],
    },
  });
  ctx.broadcast({ type: "artifact_created", artifact });
  // Y1' — persist + broadcast the preflight trace so the breadcrumb renders.
  persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_findings", pre.trace);
  await maybeEmitTaskHandle(ctx.server, artifact, ctx.store);
  await ctx.helpers.autoNameSession(artifact.title);

  // Try elicitation for quick approval
  const elicitAction = await ctx.helpers.tryElicit(
    `Findings: "${artifact.title}"\n\n` +
    `Accept to approve these findings.\n` +
    `Decline to review in detail at http://localhost:${ctx.port}`,
  );
  if (elicitAction === "approve") {
    await ctx.store.updateArtifactStatus(id, "approved", "elicit_accept");
    await maybeUpdateTaskStatus(ctx.server, id, ctx.store);
    return {
      content: [{ type: "text", text: `Findings recorded and approved (${id}).${await ctx.helpers.getPassiveFeedback()}` }],
    };
  }

  return {
    content: [{ type: "text", text: `Findings recorded (${id}). Human can review at localhost:${ctx.port}. Call check_feedback for their response.${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
