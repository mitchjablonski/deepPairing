import { nanoid } from "nanoid";
import { validatePresentFindingsInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle, maybeUpdateTaskStatus } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged } from "../tool-helpers.js";
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

  // V4 — non-blocking secret-shape scan. Flags vendor-prefixed API
  // keys + PEM blocks the agent may have pasted into evidence
  // snippets, detail text, or recommendations. Doesn't redact (the
  // user may have a legitimate reason to quote the key — e.g.,
  // reviewing a secret-scanner finding).
  // #162 — the scan lives INSIDE FileStore.createArtifact now (parity with
  // addComment): matches PERSIST on the artifact (#158) with field path +
  // line (#160), and we read them back off the returned artifact for the
  // fire-and-forget broadcast below (a no-op in daemon mode) — one scan per
  // artifact, at the choke point.
  const content = {
    summary: validated.data.summary,
    findings: validated.data.findings,
    openQuestions: validated.data.openQuestions ?? [],
  };
  const id = `art_${nanoid(10)}`;
  const artifact = await ctx.store.createArtifact({
    id,
    type: "research",
    title: args?.title ?? "Research Findings",
    content,
  });
  const secretMatches = artifact.secretWarnings ?? [];
  // AA6.3 — persist + broadcast the trace BEFORE artifact_created so the
  // companion UI can render the breadcrumb populated on first paint
  // instead of mounting it null and refetching when the trace event
  // lands. Pre-AA6.3 there was a visible flash where the breadcrumb
  // was missing on a freshly-created artifact.
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_findings", pre.trace);
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

  // Try elicitation for quick approval
  const elicitAction = await ctx.helpers.tryElicit(
    `Findings: "${artifact.title}"\n\n` +
    `Accept to approve these findings.\n` +
    `Decline to review in detail at http://localhost:${ctx.port}`,
  );
  const traceSummary = formatPreflightTraceSummary(pre.trace);
  if (elicitAction === "approve") {
    await ctx.store.updateArtifactStatus(id, "approved", "elicit_accept");
    await maybeUpdateTaskStatus(ctx.server, id, ctx.store);
    return {
      content: [{ type: "text", text: `Findings recorded and approved (${id}).${traceSummary}${await ctx.helpers.getPassiveFeedback()}` }],
    };
  }

  return {
    content: [{ type: "text", text: `Findings recorded (${id}). Human can review at localhost:${ctx.port}. Call check_feedback for their response.${traceSummary}${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
