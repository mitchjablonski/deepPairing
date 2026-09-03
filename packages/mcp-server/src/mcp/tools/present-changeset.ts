import { nanoid } from "nanoid";
import { validatePresentChangesetInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge, hashPresentArgs, buildDedupResponse, formatStyleWarnings } from "../tool-helpers.js";
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
  const { title, summary, files, risks, reviewIntent, source, visuals } = validated.data;
  // Q6 (#232) — is this the pair's own change, or a colleague's PR pulled onto
  // the review surface? Absent reviewIntent means "local" (every pre-Q6 call).
  const isExternal = reviewIntent === "external";

  // Preflight against rejected approaches. Feed the title, summary, risk chips,
  // and the changed paths so a re-attempt of a rejected changeset is caught
  // (path-scoped team-pref enforcement uses the file paths).
  //
  // Q6 (#232) — an external review must not be REFUSED by this gate, and that
  // part is still true. Blocking would let a stance the human recorded about
  // their OWN codebase refuse to DISPLAY a colleague's diff: the tool would go
  // dark exactly when the human most needs to see what they were pinged on, and
  // no revision could unblock it (you cannot revise someone else's PR).
  //
  // R1 (#279) — but Q6 implemented "must not refuse" as `pre = null`, i.e. the
  // gate was never RUN, and round 13 found what that costs. `reviewIntent:
  // "external"` is an UNVERIFIED AGENT ASSERTION — one string in one tool call
  // — and it was switching the human's taste gate off entirely. The two are
  // separable, so separate them: the matcher runs on every changeset, and on an
  // external one it comes back ADVISORY (see tool-helpers' `advisory` option —
  // no block, and no block toast/log/metric either, because nothing was
  // blocked). The agent then does what review-pr.md already asks: raise the
  // matched stance WITH the human, as an internal-audience finding. The moat
  // points outward instead of blocking inward — but it points.
  const pre = await ctx.helpers.preflightRejectedApproaches(
    "present_changeset",
    [title, summary ?? "", ...(risks ?? [])].filter(Boolean),
    files.map((f) => f.path).filter(Boolean),
    [],
    { advisory: isExternal },
  );
  if (!pre.ok) return pre.response;

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
    // R4 P-B (#284) — the changeset-level visual ("the shape of what this PR
    // touches"); thread to the store, omitted-when-absent (legacy shape intact).
    ...(visuals && visuals.length > 0 ? { visuals } : {}),
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
  // R1 (#279) — the external lane gets a trace too now. Q6 skipped it because
  // "no proposal was weighed"; since the matcher actually runs (advisory), that
  // is no longer true and the breadcrumb is the honest record of the stances
  // that WERE weighed against this PR.
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
  // R1 (#279) — the advisory match, turned into the ONE thing the agent should
  // do with it. Note where it must NOT go: a stance out of the human's own
  // philosophy ledger is theirs, not the PR author's business, so it is raised
  // as an INTERNAL finding (audience: "internal" — the gate and the payload
  // builder both refuse to post those). This is the sentence review-pr.md's
  // ledger-sweep step and the Finding schema agree on.
  const advisory = pre.advisory
    ? `\n\n⚠ YOUR PAIR'S RECORDED TASTE TOUCHES THIS PR — advisory, not a block (they did not write this code, and there is no revision that could unblock someone else's PR): ` +
      `${pre.advisory}\n` +
      `Raise it WITH THEM, not on the PR: one present_findings entry with audience: "internal", quoting their stance and its date, and let them decide whether it still applies in someone else's codebase. ` +
      `Never quote their ledger to the PR author — internal findings are excluded from every posted payload.`
    : "";
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
      `and when they say to post it, call post_pr_review (REQUEST_CHANGES only if a surviving finding is high/critical — the tool CHECKS this now and refuses otherwise — else COMMENT). No present_debrief is owed for a review of code you did not write.`
    : `When the feature wraps, end with present_debrief.`;
  return {
    content: [{
      type: "text",
      text:
        `Changeset "${artifact.title}" presented for review (${id}) — ${fileCount} file${fileCount === 1 ? "" : "s"}. ` +
        `The human reviews each file (and can comment across files) at localhost:${reviewPort}. ` +
        `Call check_feedback for their per-file review state, comments, and verdict. ` +
        `${closing}${traceSummary}${advisory}${nudge}${formatStyleWarnings(artifact.type, artifact.content)}${await ctx.helpers.getPassiveFeedback()}`,
    }],
  };
}
