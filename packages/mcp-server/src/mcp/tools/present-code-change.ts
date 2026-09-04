import { nanoid } from "nanoid";
import { preflightArtifact } from "../artifact-preflight.js";
import { validatePresentCodeChangeInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle, maybeUpdateTaskStatus } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, hashPresentArgs, buildDedupResponse, formatStyleWarnings } from "../tool-helpers.js";
import { sessionOwesDebrief } from "../../debrief-gate.js";
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

  const pre = (await preflightArtifact(ctx, "present_code_change", "code_change", "", validated.data))!;
  if (!pre.ok) return pre.response;

  // N2 (#226) — short-window de-dup: an identical present_code_change still in
  // draft returns the existing artifact rather than minting a twin card. Hashes
  // the raw args, so the history-based `before` reconstruction (which differs
  // once the first twin lands) can't defeat the match.
  const dedup = await ctx.helpers.beginPresentIdempotency("present_code_change", hashPresentArgs(args));
  if (dedup.duplicate) return buildDedupResponse(dedup.duplicate, ctx.store.getLivePort?.() ?? ctx.port);
  // O3 (#231) — LIVE bound port for the human-facing review URL (getLivePort
  // survives a TIME_WAIT idle-respawn; ctx.port is the stale spawn-time value).
  const reviewPort = ctx.store.getLivePort?.() ?? ctx.port;

  // V4 — code-change before/after snippets are the highest-risk
  // surface for leaked vendor-prefixed API keys; a refactor near
  // auth code or a finding that quotes a config block is exactly
  // where the agent might paste a real secret. See secret-scan.ts.
  // #162 — the scan moved INTO FileStore.createArtifact (parity with
  // addComment): the store walks the whole content object (#160 — each match
  // carries its field path + line) and persists the result (#158 — so the
  // warning survives a reload; the broadcast below is fire-and-forget and, in
  // daemon mode, a no-op). We read the matches back off the returned artifact
  // for the broadcast — one scan per artifact, at the choke point.
  const content = { filePath, changeType: effectiveChangeType, before: effectiveBefore, after, reasoning, confidence, concept };
  const id = `art_${nanoid(10)}`;
  let artifact: Awaited<ReturnType<typeof ctx.store.createArtifact>>;
  try {
    artifact = await ctx.store.createArtifact({
      id,
      type: "code_change",
      title: `${effectiveChangeType} ${filePath}`,
      content,
      agentReasoning: reasoning,
      relatedArtifactIds: args?.relatedFindings,
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
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_code_change", pre.trace);
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

  // J2a (#210) — ceremony scales with the task. When THIS is the trivial shape
  // (the session's only live code artifact is this one code_change, no
  // changeset, no decision/spec/plan), it CAN self-summarize and close the
  // task. F3 — the note is CONDITIONAL: this may be the first of a planned
  // sequence, so we must NOT signal completion outright. Phrase it as "if this
  // is the whole task…" so the carve-out stays teachable without mis-signaling.
  // NEVER echo "end with present_debrief" here (unlike present_changeset, which
  // always owes one). If the shape has already escalated, stay silent on the
  // debrief — the changeset/check_feedback surfaces carry that rule.
  // Computed ONCE here (before the terminal-approve branch) so both the
  // quick-approve and review return paths carry the same close-note (#215 K1).
  const allArtifacts = await ctx.store.getArtifacts();

  // #215 K1 — the changeset nudge. When the session ALREADY carries a LIVE
  // code_change for a DIFFERENT filePath this run, the default fix (another
  // per-file card) is the wrong shape: multi-file work belongs in ONE
  // present_changeset. Live = not superseded/retracted/obsolete; a re-present of
  // the SAME file (or a superseded prior of it) is not a distinct file, so it
  // doesn't trip the nudge. Reuses the getArtifacts() read above.
  const CODE_CLOSED = ["superseded", "retracted", "obsolete"];
  const hasOtherLiveFile = allArtifacts.some(
    (a) =>
      a.type === "code_change" &&
      a.id !== id &&
      !CODE_CLOSED.includes(a.status ?? "") &&
      (a.content as any)?.filePath !== filePath,
  );
  const changesetNudge = hasOtherLiveFile
    ? " 2nd file touched this run — the default for multi-file work is present_changeset; batch the remaining files into one and close with a present_debrief."
    : "";

  // AR-fix (#252 review) — closeNote and changesetNudge must never CO-FIRE. In
  // the post-debrief follow-up lane a LIVE debrief short-circuits
  // sessionOwesDebrief to false (closesTask=true), so a 2nd-file code_change
  // presented AFTER a debrief would otherwise emit BOTH "no separate
  // present_debrief owed" AND "close with a present_debrief". A distinct live
  // file always means multi-file work → the nudge wins, closeNote is silent.
  const closesTask = !sessionOwesDebrief(allArtifacts);
  const closeNote = closesTask && !hasOtherLiveFile
    ? " If this single-file change is the whole task, it closes it — fold the what-changed-and-why into `reasoning`, no separate present_debrief owed. If more changes follow, batch them into a present_changeset and close with a present_debrief."
    : "";

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
      `Decline to review the diff at http://localhost:${reviewPort}`,
    );
    if (elicitAction === "approve") {
      await ctx.store.updateArtifactStatus(id, "approved");
      await maybeUpdateTaskStatus(ctx.server, id, ctx.store);
      return {
        content: [{ type: "text", text: `Code change approved (${id}): ${effectiveChangeType} ${filePath}.${closeNote}${changesetNudge}${formatPreflightTraceSummary(pre.trace)}${formatStyleWarnings(artifact.type, artifact.content)}${await ctx.helpers.getPassiveFeedback()}` }],
      };
    }
  }

  return {
    content: [{ type: "text", text: `Code change presented for review (${id}): ${effectiveChangeType} ${filePath}. Human can review at localhost:${reviewPort}.${closeNote}${changesetNudge}${formatPreflightTraceSummary(pre.trace)}${formatStyleWarnings(artifact.type, artifact.content)}${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
