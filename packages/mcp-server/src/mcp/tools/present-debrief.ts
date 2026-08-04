import { nanoid } from "nanoid";
import { validatePresentDebriefInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge } from "../tool-helpers.js";
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
  const { title, summary, sections, decisionsMade, needsYourEyes, deferred, openQuestions } = validated.data;

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

  const id = `art_${nanoid(10)}`;
  const content = {
    summary,
    ...(sections && sections.length > 0 ? { sections } : {}),
    ...(decisionsMade && decisionsMade.length > 0 ? { decisionsMade } : {}),
    ...(needsYourEyes && needsYourEyes.length > 0 ? { needsYourEyes } : {}),
    ...(deferred && deferred.length > 0 ? { deferred } : {}),
    ...(openQuestions && openQuestions.length > 0 ? { openQuestions } : {}),
  };
  // #162 parity — the secret scan runs INSIDE createArtifact; a debrief narrates
  // real code and may inline a snippet, so it's a scan surface like the others.
  const artifact = await ctx.store.createArtifact({
    id,
    type: "debrief",
    title,
    content,
    relatedArtifactIds: args?.relatedFindings,
  });
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
  const sectionCount = sections?.length ?? 0;
  const eyesCount = needsYourEyes?.length ?? 0;
  return {
    content: [{
      type: "text",
      text:
        `Debrief "${artifact.title}" presented for review (${id}) — ${sectionCount} section${sectionCount === 1 ? "" : "s"}` +
        `${eyesCount > 0 ? `, ${eyesCount} item${eyesCount === 1 ? "" : "s"} flagged for your eyes` : ""}. ` +
        `This is the primary comprehension surface: the human reads the walk-through and can ask ANYTHING in the thread at localhost:${ctx.port}. ` +
        `Call check_feedback for their questions, comments, and verdict.${traceSummary}${nudge}${await ctx.helpers.getPassiveFeedback()}`,
    }],
  };
}
