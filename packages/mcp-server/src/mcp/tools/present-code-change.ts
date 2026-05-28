import { nanoid } from "nanoid";
import { validatePresentCodeChangeInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle, maybeUpdateTaskStatus } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged } from "../tool-helpers.js";
import { scanManyForSecrets } from "../../secret-scan.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handlePresentCodeChange(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validatePresentCodeChangeInput(args);
  if (!validated.ok) return validated.error;
  const { filePath, changeType, before, after, reasoning, confidence, concept } = validated.data;

  // #3 — when `before` is omitted, reconstruct it from the most recent prior
  // code_change for the same file so the UI renders a focused diff instead of
  // the whole file. Do this REGARDLESS of the agent's changeType: agents
  // routinely mislabel a real modification as "create", which (empty before)
  // suppresses the diff and shows the file under a "create" banner. History is
  // the source of truth, not the label.
  let effectiveBefore = before;
  let effectiveChangeType = changeType;
  if (!effectiveBefore) {
    try {
      const prior = (await ctx.store.getArtifacts())
        .filter((a) =>
          a.type === "code_change" &&
          (a.content as any)?.filePath === filePath &&
          typeof (a.content as any)?.after === "string" &&
          (a.content as any).after.length > 0,
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      if (prior) effectiveBefore = (prior.content as any).after as string;
    } catch {
      // best-effort; fall back to the empty before (full-file view)
    }
  }
  // A change with real prior content is a modification, not a creation —
  // correct the label so the diff renders and the banner is accurate.
  if (effectiveBefore && effectiveChangeType === "create") {
    effectiveChangeType = "modify";
  }

  const proposals: string[] = [filePath, reasoning].filter(Boolean);
  const proposalPaths: string[] = [filePath];
  const pre = await ctx.helpers.preflightRejectedApproaches("present_code_change", proposals, proposalPaths);
  if (!pre.ok) return pre.response;

  const id = `art_${nanoid(10)}`;
  const artifact = await ctx.store.createArtifact({
    id,
    type: "code_change",
    title: `${effectiveChangeType} ${filePath}`,
    content: { filePath, changeType: effectiveChangeType, before: effectiveBefore, after, reasoning, confidence, concept },
    agentReasoning: reasoning,
    relatedArtifactIds: args?.relatedFindings,
  });
  // AA6.3 — trace before broadcast so the breadcrumb is populated on
  // first paint (see present-findings.ts for the full rationale).
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_code_change", pre.trace);
  ctx.broadcast({ type: "artifact_created", artifact });
  // V4 — code-change before/after snippets are the highest-risk
  // surface for leaked vendor-prefixed API keys; a refactor near
  // auth code or a finding that quotes a config block is exactly
  // where the agent might paste a real secret. See secret-scan.ts.
  const secretMatches = scanManyForSecrets([effectiveBefore, after, reasoning]);
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

  // S7 — quick-approve via elicitation for small, confident edits.
  // Threshold: ≤ 20 changed lines AND no low-confidence flag. Bigger or
  // hedged changes route straight to the companion UI where the diff +
  // reasoning + linked findings render in full. Threshold is intentionally
  // conservative — terminal accept is a great escape hatch for tiny edits,
  // a footgun for sprawling ones.
  const changedLines = effectiveBefore.split("\n").length + after.split("\n").length;
  const isSmallEdit = changedLines <= 20;
  const isConfident = (confidence ?? "").toLowerCase() !== "low";
  if (isSmallEdit && isConfident) {
    const elicitAction = await ctx.helpers.tryElicit(
      `Apply ${changeType} to ${filePath}?\n\n` +
      `Accept to approve this change.\n` +
      `Decline to review the diff at http://localhost:${ctx.port}`,
    );
    if (elicitAction === "approve") {
      await ctx.store.updateArtifactStatus(id, "approved");
      await maybeUpdateTaskStatus(ctx.server, id, ctx.store);
      return {
        content: [{ type: "text", text: `Code change approved (${id}): ${effectiveChangeType} ${filePath}.${formatPreflightTraceSummary(pre.trace)}${await ctx.helpers.getPassiveFeedback()}` }],
      };
    }
  }

  return {
    content: [{ type: "text", text: `Code change presented for review (${id}): ${effectiveChangeType} ${filePath}. Human can review at localhost:${ctx.port}.${formatPreflightTraceSummary(pre.trace)}${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
