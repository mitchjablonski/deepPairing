import { nanoid } from "nanoid";
import { validatePresentDebriefInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge, linkServedRequest, hashPresentArgs, buildDedupResponse, formatStyleWarnings } from "../tool-helpers.js";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * #190 — present ONE debrief at the end of a feature / autonomous run: what
 * changed and why (the narrative), the calls the agent made WITHOUT the human
 * (the accountability block), what needs the human's eyes (the prioritized
 * review list), what was deferred, and an ask-anything thread. This is the
 * PRIMARY comprehension surface — the thesis's 80% case: "shared understanding
 * after building a feature, with a place to ask questions."
 *
 * Non-blocking, exactly like present_findings/present_changeset: it records the
 * artifact, pushes it over the WebSocket, and returns immediately with the
 * companion URL — the human reads it and asks questions in the companion UI, and
 * the agent polls check_feedback for their comments, questions, and verdict.
 */
export async function handlePresentDebrief(ctx: ToolContext, args: any): Promise<ToolResult> {
  const validated = validatePresentDebriefInput(args);
  if (!validated.ok) return validated.error;
  const { title, summary, sections, decisionsMade, needsYourEyes, deferred, openQuestions, visuals } = validated.data;

  // Preflight against rejected approaches. Feed the title, the narrative
  // summary, the section titles, and any named concepts so a debrief re-proposing
  // a rejected approach is caught (concept↔concept lane).
  const proposals: string[] = [
    title,
    summary,
    ...(sections ?? []).map((s) => s.title),
    ...(decisionsMade ?? []).map((d) => d.what),
  ].filter(Boolean);
  const proposalConcepts: string[] = (sections ?? [])
    .flatMap((s) => (s.concepts ?? []).map((c) => c.name))
    .filter(Boolean);
  const pre = await ctx.helpers.preflightRejectedApproaches("present_debrief", proposals, [], proposalConcepts);
  if (!pre.ok) return pre.response;

  // N2 (#226, F5) — short-window de-dup for an identical, still-draft debrief
  // (same begin/commit/abort pattern as the other 7 present_* tools).
  const dedup = await ctx.helpers.beginPresentIdempotency("present_debrief", hashPresentArgs(args));
  if (dedup.duplicate) return buildDedupResponse(dedup.duplicate, ctx.store.getLivePort?.() ?? ctx.port);
  // O3 (#231) — LIVE bound port for the human-facing review URL (getLivePort
  // survives a TIME_WAIT idle-respawn; ctx.port is the stale spawn-time value).
  const reviewPort = ctx.store.getLivePort?.() ?? ctx.port;

  const id = `art_${nanoid(10)}`;
  const content = {
    summary,
    ...(sections && sections.length > 0 ? { sections } : {}),
    ...(decisionsMade && decisionsMade.length > 0 ? { decisionsMade } : {}),
    ...(needsYourEyes && needsYourEyes.length > 0 ? { needsYourEyes } : {}),
    ...(deferred && deferred.length > 0 ? { deferred } : {}),
    ...(openQuestions && openQuestions.length > 0 ? { openQuestions } : {}),
    // R4 P-B (#284) — visuals framing the debrief; thread to the store.
    ...(visuals && visuals.length > 0 ? { visuals } : {}),
  };
  // #162 parity — the secret scan runs INSIDE createArtifact; a debrief narrates
  // real code and may inline a snippet, so it's a scan surface like the others.
  let artifact: Awaited<ReturnType<typeof ctx.store.createArtifact>>;
  try {
    artifact = await ctx.store.createArtifact({
      id,
      type: "debrief",
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
  // AA6.3 — trace before broadcast so the breadcrumb paints populated.
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_debrief", pre.trace);
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
  // Steer re-posts toward revise_artifact when a live debrief with a similar
  // title already exists (a revision that should supersede, not re-post).
  const nudge = await revisionNudge(ctx.store, "debrief", title, id);
  // G1 (#198b) — link a served request if the agent named one.
  const servedNote = await linkServedRequest(ctx.store, args, artifact.id);
  const sectionCount = sections?.length ?? 0;
  const eyesCount = needsYourEyes?.length ?? 0;

  // #225 (N1, item 4) — dangling drill-in refs. A debrief's sections and
  // needsYourEyes items link to underlying artifacts (changesetRef / artifactRefs
  // / artifactRef). Pre-this, an id that resolves to NOTHING (a typo, or a
  // fabricated "art_DOESNOTEXIST") was accepted silently — the human clicks a
  // drill-in link that goes nowhere. WARN, don't reject: a ref to a WITHDRAWN /
  // superseded artifact still resolves to a real record (it exists in the store,
  // just isn't the live head), and pointing at that history can be legitimate —
  // so we only flag ids that match NO artifact at all. The ArtifactRefLink UI
  // already degrades gracefully for these (it renders the raw id, verified — not
  // changed). Report ONCE in the success text so the agent can self-correct.
  const refIds: string[] = [
    ...(sections ?? []).flatMap((s) => [
      ...(typeof s.changesetRef === "string" ? [s.changesetRef] : []),
      ...(Array.isArray(s.artifactRefs) ? s.artifactRefs : []),
    ]),
    ...(needsYourEyes ?? []).flatMap((n) => (typeof n.artifactRef === "string" ? [n.artifactRef] : [])),
  ].filter((r): r is string => typeof r === "string" && r.length > 0);
  const knownIds = new Set((await ctx.store.getArtifacts()).map((a) => a.id));
  // Preserve first-seen order, de-dupe, and drop any that resolve.
  const dangling = [...new Set(refIds)].filter((r) => !knownIds.has(r));
  const danglingNote =
    dangling.length > 0
      ? ` ⚠ ${dangling.length} reference${dangling.length === 1 ? "" : "s"} don't resolve to a live artifact: ${dangling.join(", ")} — the drill-in link${dangling.length === 1 ? "" : "s"} will go nowhere. Fix the id${dangling.length === 1 ? "" : "s"} (or drop the ref) with revise_artifact if that wasn't intentional.`
      : "";

  return {
    content: [{
      type: "text",
      text:
        `Debrief "${artifact.title}" presented for review (${id}) — ${sectionCount} section${sectionCount === 1 ? "" : "s"}` +
        `${eyesCount > 0 ? `, ${eyesCount} item${eyesCount === 1 ? "" : "s"} flagged for your eyes` : ""}. ` +
        `This is the primary comprehension surface: the human reads the walk-through and can ask ANYTHING in the thread at localhost:${reviewPort}. ` +
        `Call check_feedback for their questions, comments, and verdict.${danglingNote}${servedNote}${traceSummary}${nudge}${formatStyleWarnings(artifact.type, artifact.content)}${await ctx.helpers.getPassiveFeedback()}`,
    }],
  };
}
