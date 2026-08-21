import { nanoid } from "nanoid";
import { validatePresentChangesetInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge, hashPresentArgs, buildDedupResponse } from "../tool-helpers.js";
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
  const { title, summary, files, risks, reviewIntent, source } = validated.data;
  // Q6 (#232) — is this the pair's own change, or a colleague's PR pulled onto
  // the review surface? Absent reviewIntent means "local" (every pre-Q6 call).
  const isExternal = reviewIntent === "external";

  // Preflight against rejected approaches. Feed the title, summary, risk chips,
  // and the changed paths so a re-attempt of a rejected changeset is caught
  // (path-scoped team-pref enforcement uses the file paths).
  //
  // Q6 (#232) — SKIPPED for an external review, and this is a semantic call,
  // not an optimization. The gate's question is "are you proposing something
  // the human already turned down?" For a GitHub PR the answer is structurally
  // no: the agent is not proposing this code, it is showing it. Running the
  // gate here would let a stance the human recorded about their OWN codebase
  // refuse to DISPLAY a colleague's diff — the tool would go dark exactly when
  // the human most needs to see what they were pinged on, and there would be no
  // revision that could unblock it (you cannot revise someone else's PR).
  //
  // The stance is not lost, it is INVERTED: the review-pr command has the agent
  // run `recall` over the PR's concepts and surface any match as a FINDING on
  // the PR ("this introduces X, which you rejected on <date>: '<reason>'").
  // The moat points outward instead of blocking inward.
  const pre = isExternal
    ? null
    : await ctx.helpers.preflightRejectedApproaches(
        "present_changeset",
        [title, summary ?? "", ...(risks ?? [])].filter(Boolean),
        files.map((f) => f.path).filter(Boolean),
      );
  if (pre && !pre.ok) return pre.response;

  // N2 (#226) — short-window de-dup for an identical, still-draft changeset.
  const dedup = await ctx.helpers.beginPresentIdempotency("present_changeset", hashPresentArgs(args));
  if (dedup.duplicate) return buildDedupResponse(dedup.duplicate, ctx.store.getLivePort?.() ?? ctx.port);
  // O3 (#231) — LIVE bound port for the human-facing review URL (getLivePort
  // survives a TIME_WAIT idle-respawn; ctx.port is the stale spawn-time value).
  const reviewPort = ctx.store.getLivePort?.() ?? ctx.port;

  const id = `art_${nanoid(10)}`;
  const content = {
    ...(summary ? { summary } : {}),
    files,
    ...(risks && risks.length > 0 ? { risks } : {}),
    // Q6 (#232) — spread-when-present, never defaulted in. A local changeset's
    // content stays byte-identical to every changeset written before Q6 existed
    // (absent reviewIntent already MEANS local), so nothing downstream — the
    // store, the exporter, the goldens — sees a shape it didn't see yesterday.
    ...(reviewIntent ? { reviewIntent } : {}),
    ...(source ? { source } : {}),
  };
  // #162 — the secret scan runs INSIDE createArtifact (parity with the other
  // present_* tools): a diff hunk is a high-risk surface for a pasted key.
  // Matches persist on the artifact (labels + location only, never the value);
  // read them back for the fire-and-forget broadcast below.
  let artifact: Awaited<ReturnType<typeof ctx.store.createArtifact>>;
  try {
    artifact = await ctx.store.createArtifact({
      id,
      type: "changeset",
      title,
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
  // AA6.3 — trace before broadcast so the breadcrumb paints populated (see
  // present-findings.ts for the full rationale).
  // Q6 — no trace for an external review: no proposal was weighed, so a
  // breadcrumb claiming otherwise would be a false record.
  if (pre) await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_changeset", pre.trace);
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

  const traceSummary = pre ? formatPreflightTraceSummary(pre.trace) : "";
  // Steer re-posts toward revise_artifact when a live changeset with a similar
  // title already exists (a revision that should supersede, not re-post).
  const nudge = await revisionNudge(ctx.store, "changeset", title, id);
  const fileCount = files.length;
  // Q6 (#232) — the CLOSING instruction diverges by intent, because the two
  // sessions end in different places. Local work ends in a debrief (here is
  // what we built and why). An external review ends in a POSTED REVIEW on the
  // PR — telling the agent to "end with present_debrief" there would have it
  // narrate a colleague's feature back to the person who just reviewed it.
  const prLabel = source?.number ? `PR #${source.number}` : "the PR";
  const closing = isExternal
    ? `This is an EXTERNAL review — ${prLabel}${source?.author ? ` by ${source.author}` : ""} is someone else's code. ` +
      `Their per-file verdicts are their REVIEW OPINION and stay LOCAL: nothing is posted and nothing lands until they say to post it. ` +
      `Do NOT apply, revise, or "fix" these files. Keep polling check_feedback and answer what they ask — trace callers, read the surrounding code, run a safe test — ` +
      `and when they say to post it, call post_pr_review (REQUEST_CHANGES only if a surviving finding is high/critical, else COMMENT). No present_debrief is owed for a review of code you did not write.`
    : `When the feature wraps, end with present_debrief.`;
  return {
    content: [{
      type: "text",
      text:
        `Changeset "${artifact.title}" presented for review (${id}) — ${fileCount} file${fileCount === 1 ? "" : "s"}. ` +
        `The human reviews each file (and can comment across files) at localhost:${reviewPort}. ` +
        `Call check_feedback for their per-file review state, comments, and verdict. ` +
        `${closing}${traceSummary}${nudge}${await ctx.helpers.getPassiveFeedback()}`,
    }],
  };
}
