import { nanoid } from "nanoid";
import { validatePresentChangesetInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge } from "../tool-helpers.js";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * #171 — present a multi-file change as ONE reviewable artifact (unified diffs,
 * per-file review state, cross-file comment anchors). Non-blocking, exactly
 * like present_findings/present_spec: it records the artifact, pushes it over
 * the WebSocket, and returns immediately with the companion URL — the human
 * reviews each file in the companion UI and the agent polls check_feedback.
 *
 * Deliberately NO elicitation quick-approve path (unlike small code_change
 * edits): a change spanning multiple files is exactly what the rich per-file
 * review surface exists for, so terminal accept would defeat the point.
 */
export async function handlePresentChangeset(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validatePresentChangesetInput(args);
  if (!validated.ok) return validated.error;
  const { title, summary, files, risks } = validated.data;

  // Preflight against rejected approaches. Feed the title, summary, risk chips,
  // and the changed paths so a re-attempt of a rejected changeset is caught
  // (path-scoped team-pref enforcement uses the file paths).
  const proposals: string[] = [title, summary ?? "", ...(risks ?? [])].filter(Boolean);
  const proposalPaths: string[] = files.map((f) => f.path).filter(Boolean);
  const pre = await ctx.helpers.preflightRejectedApproaches("present_changeset", proposals, proposalPaths);
  if (!pre.ok) return pre.response;

  const id = `art_${nanoid(10)}`;
  const content = {
    ...(summary ? { summary } : {}),
    files,
    ...(risks && risks.length > 0 ? { risks } : {}),
  };
  // #162 — the secret scan runs INSIDE createArtifact (parity with the other
  // present_* tools): a diff hunk is a high-risk surface for a pasted key.
  // Matches persist on the artifact (labels + location only, never the value);
  // read them back for the fire-and-forget broadcast below.
  const artifact = await ctx.store.createArtifact({
    id,
    type: "changeset",
    title,
    content,
    relatedArtifactIds: args?.relatedFindings,
  });
  const secretMatches = artifact.secretWarnings ?? [];
  // AA6.3 — trace before broadcast so the breadcrumb paints populated (see
  // present-findings.ts for the full rationale).
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_changeset", pre.trace);
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

  const traceSummary = formatPreflightTraceSummary(pre.trace);
  // Steer re-posts toward revise_artifact when a live changeset with a similar
  // title already exists (a revision that should supersede, not re-post).
  const nudge = await revisionNudge(ctx.store, "changeset", title, id);
  const fileCount = files.length;
  return {
    content: [{
      type: "text",
      text:
        `Changeset "${artifact.title}" presented for review (${id}) — ${fileCount} file${fileCount === 1 ? "" : "s"}. ` +
        `The human reviews each file (and can comment across files) at localhost:${ctx.port}. ` +
        `Call check_feedback for their per-file review state, comments, and verdict.${traceSummary}${nudge}${await ctx.helpers.getPassiveFeedback()}`,
    }],
  };
}
