import { nanoid } from "nanoid";
import { validatePresentExplainerInput } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge } from "../tool-helpers.js";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * #190 A2 — present a read-only EXPLAINER: a narrated, ordered walk-through of
 * how something WORKS. Code archaeology ("how does auth work here?"), onboarding,
 * a spike readout. Each section is anchored to real Evidence and rendered through
 * the same Evidence + CommentableCode stack (per-line commenting works), but the
 * explainer deliberately drops findings' problem-framing — no severity, no
 * significance, no recommendation. It explains; it doesn't flag.
 *
 * Non-blocking, exactly like present_findings/present_debrief: it records the
 * artifact, pushes it over the WebSocket, and returns immediately with the
 * companion URL — the human reads the walk-through and can ask ANYTHING in the
 * thread, and the agent polls check_feedback for their comments and questions.
 */
export async function handlePresentExplainer(ctx: ToolContext, args: Record<string, unknown> | null | undefined): Promise<ToolResult> {
  const validated = validatePresentExplainerInput(args);
  if (!validated.ok) return validated.error;
  const { title, overview, sections, relatedArtifactIds, suggestedQuestions } = validated.data;

  // Preflight against rejected approaches. Feed the title, the overview, and the
  // section headings so an explainer re-narrating a rejected approach is caught.
  // No concepts arm — the explainer carries no named concepts (it explains code
  // as-is rather than proposing a pattern).
  const proposals: string[] = [
    title,
    overview,
    ...(sections ?? []).map((s) => s.heading),
  ].filter(Boolean);
  const pre = await ctx.helpers.preflightRejectedApproaches("present_explainer", proposals, [], []);
  if (!pre.ok) return pre.response;

  const id = `art_${nanoid(10)}`;
  const content = {
    title,
    overview,
    sections,
    ...(relatedArtifactIds && relatedArtifactIds.length > 0 ? { relatedArtifactIds } : {}),
    ...(suggestedQuestions && suggestedQuestions.length > 0 ? { suggestedQuestions } : {}),
  };
  // #162 parity — the secret scan runs INSIDE createArtifact; an explainer inlines
  // real code snippets as evidence, so it's a scan surface like the others.
  const artifact = await ctx.store.createArtifact({
    id,
    type: "explainer",
    title,
    content,
    relatedArtifactIds,
  });
  const secretMatches = artifact.secretWarnings ?? [];
  // AA6.3 — trace before broadcast so the breadcrumb paints populated.
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_explainer", pre.trace);
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
  // Steer re-posts toward revise_artifact when a live explainer with a similar
  // title already exists (a revision that should supersede, not re-post).
  const nudge = await revisionNudge(ctx.store, "explainer", title, id);
  const sectionCount = sections?.length ?? 0;
  // #193 E2 — pull-first call-to-action nudge (a WARNING, never a rejection).
  // An explainer with no suggestedQuestions and no chips is the reasoning-card
  // failure mode: agent-pushed, no call to action, read by ~nobody. We can't see
  // from here whether the human explicitly asked, so we don't block — we remind:
  // if you initiated this yourself, seed suggestedQuestions so it has a CTA.
  const ctaNudge =
    (suggestedQuestions?.length ?? 0) === 0
      ? ` ⚠ No suggestedQuestions — if you initiated this explainer yourself (not on an explicit "explain X" ask), add 2–3 so it has a call to action; a no-CTA agent-pushed explainer is the reasoning-card 1%-engagement trap.`
      : "";
  return {
    content: [{
      type: "text",
      text:
        `Explainer "${artifact.title}" presented for review (${id}) — a read-only walk-through of ${sectionCount} section${sectionCount === 1 ? "" : "s"}. ` +
        `The human reads it in order and can ask ANYTHING in the thread at localhost:${ctx.port}. ` +
        `Call check_feedback for their questions and comments.${ctaNudge}${traceSummary}${nudge}${await ctx.helpers.getPassiveFeedback()}`,
    }],
  };
}
