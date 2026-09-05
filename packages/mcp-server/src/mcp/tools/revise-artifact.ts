import { nanoid } from "nanoid";
import { coerceChangesetContent, type DecisionOption } from "@deeppairing/shared";
import type { ToolContext, ToolResult } from "./types.js";
import { notifyResourcesListChanged, formatStyleWarnings, persistPreflightTrace } from "../tool-helpers.js";
import { preflightArtifact } from "../artifact-preflight.js";
import { maybeUpdateTaskStatus } from "../tasks-probe.js";
import {
  validatePresentFindingsInput,
  validatePresentSpecInput,
  validatePresentPlanInput,
  validatePresentOptionsInput,
  validatePresentCodeChangeInput,
  validatePresentChangesetInput,
  validatePresentDebriefInput,
  validatePresentExplainerInput,
  validateLogReasoningInput,
} from "../validate-tool-input.js";

/**
 * F3 — supersede routes the new content through the SAME strict validator the
 * original present_* tool uses, keyed on the artifact type (a revision must not
 * be able to persist a shape present_* would have rejected).
 */
type SupersedeValidator = (args: any) => { ok: true; data: unknown } | { ok: false; error: ToolResult };
const SUPERSEDE_VALIDATORS: Record<string, SupersedeValidator> = {
  research: validatePresentFindingsInput,
  spec: validatePresentSpecInput,
  plan: validatePresentPlanInput,
  decision: validatePresentOptionsInput,
  code_change: validatePresentCodeChangeInput,
  // #171 — without this entry the lookup returned undefined and a malformed
  // changeset (e.g. files: "nope") superseded straight to disk as a silently
  // empty v2 with no error for the agent to self-correct from.
  changeset: validatePresentChangesetInput,
  // #190 — a revised debrief must pass the same strict validator as
  // present_debrief (summary required, echo guard, optional-tolerant rest).
  debrief: validatePresentDebriefInput,
  // #190 A2 — a revised explainer must pass the same strict validator as
  // present_explainer (title + overview + non-empty sections, echo guard).
  explainer: validatePresentExplainerInput,
  reasoning: validateLogReasoningInput,
};

/** B3 — revise_artifact, extracted verbatim from the server.ts switch. */
export async function handleReviseArtifact(ctx: ToolContext, args: any): Promise<ToolResult> {
  const { store, server, broadcast } = ctx;

  const artifactId = String(args?.artifactId ?? "").trim();
  const mode = args?.mode as "supersede" | "retract" | "obsolete" | undefined;
  const reason = String(args?.reason ?? "").trim();
  if (!artifactId || !reason || (mode !== "supersede" && mode !== "retract" && mode !== "obsolete")) {
    return {
      content: [{ type: "text", text: "revise_artifact requires artifactId, mode ('supersede' | 'retract' | 'obsolete'), and reason." }],
      isError: true,
    };
  }

  if (mode === "supersede") {
    const suppliedContent = (args?.content && typeof args.content === "object" && !Array.isArray(args.content))
      ? args.content as Record<string, unknown>
      : null;
    if (!suppliedContent) {
      return {
        content: [{ type: "text", text: "revise_artifact with mode='supersede' requires a `content` object (same shape the original present_* tool accepts)." }],
        isError: true,
      };
    }
    const all = await store.getArtifacts();
    const old = all.find((a) => a.id === artifactId);
    if (!old) {
      return {
        content: [{ type: "text", text: `revise_artifact: no artifact with id ${artifactId}.` }],
        isError: true,
      };
    }
    // F5 — don't supersede a CLOSED artifact. Beyond already-superseded/
    // retracted, resurrecting a 'rejected' or 'obsolete' artifact into a
    // fresh v(N+1) draft re-opens work the human deliberately closed (and
    // re-queues a pending review). Only live artifacts can be revised.
    if (["superseded", "retracted", "rejected", "obsolete"].includes(old.status)) {
      return {
        content: [{ type: "text", text: `revise_artifact: ${artifactId} is ${old.status} — a closed artifact can't be superseded. Present a new artifact instead.` }],
        isError: true,
      };
    }

    // An external changeset stays somebody else's PR when it is revised. The
    // revise contract asks for replacement content, so callers commonly omit
    // the review-only metadata. Preserve that identity and its display
    // provenance, but NEVER inherit headSha: changing the content means the
    // old reviewed commit no longer describes v2. A caller that fetched and
    // presented a fresh immutable diff may supply a new source explicitly.
    const content: Record<string, unknown> = { ...suppliedContent };
    if (old.type === "changeset") {
      const oldChangeset = coerceChangesetContent(old.content);
      if (oldChangeset.reviewIntent === "external") {
        content.reviewIntent = "external";
        if (content.source === undefined && oldChangeset.source) {
          const { headSha: _reviewedCommit, ...displayProvenance } = oldChangeset.source;
          content.source = displayProvenance;
        }
      }
    }

    // F3 — route the new content through the SAME strict validator the
    // original present_* tool uses, keyed on the artifact type. Pre-this,
    // supersede only checked `typeof content === "object"`, so a revision
    // could persist a malformed shape that present_* would have rejected
    // (defeating the "bad shape never lands on disk" invariant). The
    // validators read fields off one args object, so merge in the title.
    const supersedeValidator = SUPERSEDE_VALIDATORS[old.type];
    if (supersedeValidator) {
      const v = supersedeValidator({ title: args?.title ?? old.title, ...(content as Record<string, unknown>) });
      if (!v.ok) return v.error;
    }
    // A replacement proposes new work just like its original presentation.
    // Refuse before creating v2 or changing v1 so a blocked revision is atomic.
    const pre = await preflightArtifact(ctx, "revise_artifact", old.type, String(args?.title ?? old.title), content);
    if (pre && !pre.ok) return pre.response;
    // #171 — reviewState is HUMAN-driven review PROGRESS, never agent input. A
    // v2 changeset must start with FRESH review state: carrying an echoed
    // reviewState/reviewReasons forward would stamp stale ✓ marks and old human
    // objections onto files whose diff just changed. The handler persists the
    // RAW `content` (not the validator's stripped `data`), so drop both here.
    // (present_changeset already ignores them on the create path.)
    if (old.type === "changeset") {
      delete content.reviewState;
      delete content.reviewReasons;
    }

    const title = String(args?.title ?? old.title);
    const newId = `art_${nanoid(10)}`;
    // F1 — a superseded decision needs a fresh server-minted decisionId
    // baked into content BEFORE persistence. The supersede input shape
    // (present_options) carries none, so without this the new decision had
    // no DecisionRecord and the human's later selection was silently
    // dropped (resolve no-ops → no resolved report, no ledger learning).
    // D7 — ONE typed view replaces the ten (content as any) reads that
    // followed: the validator above just ACCEPTED this shape, so the cast is
    // an honest post-validation narrowing, not a guess.
    const decisionContent =
      old.type === "decision"
        ? (content as { options?: unknown[]; decisionId?: string; stakes?: "low" | "medium" | "high"; context?: string })
        : null;
    if (decisionContent && Array.isArray(decisionContent.options)) {
      decisionContent.decisionId = `dec_${nanoid(10)}`;
      const oldStakes = (old.content as { stakes?: "low" | "medium" | "high" } | null)?.stakes;
      if (decisionContent.stakes === undefined && oldStakes !== undefined) {
        decisionContent.stakes = oldStakes;
      }
    }
    // #158 — the REVISED content is re-scanned for secret shapes: supersede
    // creates a brand-new artifact, so a v2 must not silently drop a v1's
    // persisted secretWarnings (or miss a secret pasted into the revision).
    // #162 — that re-scan now happens INSIDE createArtifact (the store is the
    // authoritative choke point, parity with addComment) — no handler-side
    // scan needed here.
    const newArtifact = await store.createArtifact({
      id: newId,
      type: old.type,
      title,
      content: content as Record<string, unknown>,
      agentReasoning: reason,
      parentId: old.id,
      version: old.version + 1,
      // Bug4 — carry the old version's relatedArtifactIds onto v2 so the
      // reference graph doesn't dangle at the SOURCE when v1 is superseded
      // (belt-and-suspenders with the client-side resolveToLiveId in the flow
      // sidebar). Optional field; only set when the old artifact had refs.
      ...(old.relatedArtifactIds ? { relatedArtifactIds: old.relatedArtifactIds } : {}),
      // #206 (I1) — carry the feature tag onto v2 so a superseded artifact's
      // successor stays in the same feature group by its OWN tag, not only via
      // the parentId chain. The store re-normalizes (idempotent on a slug).
      ...(old.featureId ? { feature: old.featureId } : {}),
    });
    await store.updateArtifactStatus(old.id, "superseded", "agent_supersede");
    await maybeUpdateTaskStatus(server, old.id, store);

    await store.addComment({
      id: `cmt_${nanoid(10)}`,
      artifactId: old.id,
      content: `Superseded by ${newId}: ${reason}`,
      author: "agent",
    });

    if (decisionContent?.options && decisionContent.decisionId) {
      await store.recordDecisionRequest({
        decisionId: decisionContent.decisionId,
        artifactId: newId,
        context: decisionContent.context ?? title,
        // Validated by SUPERSEDE_VALIDATORS (present_options schema) above.
        options: decisionContent.options as DecisionOption[],
        stakes: decisionContent.stakes,
      });
    }
    if (old.type === "plan") {
      await store.recordPlanReview(newId);
    }

    if (pre?.ok) await persistPreflightTrace(store, broadcast, newArtifact, "revise_artifact", pre.trace);
    broadcast({ type: "artifact_created", artifact: newArtifact });
    broadcast({ type: "artifact_updated", artifactId: old.id, status: "superseded" });
    // HH10 — supersede creates a new resource AND retires the old
    // one's content. Both are list-changing events.
    notifyResourcesListChanged(server);

    // #225 (N1) — the supersede-swallow fix. DELIBERATELY no getPassiveFeedback()
    // here (unlike the retract/obsolete path below and every present_* tool). That
    // helper drains ALL unacknowledged human comments session-wide, ACKNOWLEDGES
    // them, and dumps them as bare context-free lines. On a supersede that would
    // SWALLOW the human's still-undrained v1 comments/questions/suggestions — the
    // agent never called check_feedback, so those comments were never delivered
    // with their v1 context, never routed to their proper obligation lane, and
    // never carried onto v2. The comment flipped acknowledged and vanished
    // everywhere (the #225 ship-blocker).
    //
    // CARRY, don't block (the deliberate design asymmetry vs. withdraw_artifact):
    // a supersede is usually the agent legitimately improving the artifact, so
    // refusing it (the way withdraw REFUSES on undrained comments) would fight the
    // review loop. Instead we leave those v1 comments UNACKNOWLEDGED. They survive
    // the supersede and the NEXT check_feedback delivers each one richly through
    // deliverComment (its artsForTargets snapshot still contains the superseded v1,
    // so titles/findings/options resolve and a QUESTION keeps its answer_question
    // obligation, a SUGGESTION keeps its must-respond obligation). The UI already
    // renders them on the v2 view via useChainComments (whole-chain read).
    //
    // So: withdraw BLOCKS (a retraction must never dodge review), supersede CARRIES
    // (a revision must never lose the review it hasn't seen yet). Both protect the
    // same invariant — no human input is ever swallowed — by opposite means.
    // The fix-it path echoes style too. A supersede is the ONE call where the
    // agent is rewriting prose it already wrote, so it is the only place the
    // STYLE block can be acted on immediately rather than "next artifact" —
    // and pre-this it was the one present-shaped path that stayed silent.
    const advisory = pre?.ok && pre.advisory
      ? `\n\n⚠ Recalled stance — advisory, not a block (this revision records external or historical material rather than proposing that approach): ${pre.advisory}`
      : "";
    return {
      content: [{ type: "text", text: `Superseded ${artifactId} → ${newId} (v${old.version + 1}). Draft is awaiting review. Any comments the human left on ${artifactId} that you haven't read yet will arrive on your next check_feedback (they carry onto v${old.version + 1}).${formatStyleWarnings(newArtifact.type, newArtifact.content)}${advisory}` }],
    };
  }

  // mode === "retract" | "obsolete" — both close a still-open artifact
  // with no replacement. retract = "shouldn't have presented it";
  // obsolete = "valid, but overcome by new information / I've moved on".
  const artifacts = await store.getArtifacts();
  const artifact = artifacts.find((a) => a.id === artifactId);
  if (!artifact) {
    return {
      content: [{ type: "text", text: `revise_artifact: no artifact with id ${artifactId}.` }],
      isError: true,
    };
  }
  // R1 (#279) — THE UN-ARM EXIT, and its exact boundary.
  //
  // The hole: in an external-review session, approving a findings artifact ARMS
  // it — it may be posted to a stranger's repository from then on, by either
  // door, forever. There was no way back. `approved` is terminal for a reason
  // (a human verdict must be sticky; see verdict-guard.ts) and both retract and
  // withdraw refused on it, so "actually, don't send that one" had no
  // expression at all: the human's only options were to leave a live payload
  // armed or to have the agent post something they no longer wanted sent.
  //
  // THE EXIT, kept as narrow as it can be and still be an exit:
  //   • retract ONLY (obsolete stays draft/reviewing-only — "overcome by new
  //     information" is a queue gesture, not a disarm);
  //   • research artifacts ONLY (they are what post; a changeset's approval is
  //     the APPROVE authorization and disarming it is the human's own call in
  //     the UI, not the agent's);
  //   • and ONLY in a session that carries EXTERNAL review intent, i.e. one
  //     where approval means "may leave the machine". In a local session,
  //     approved still means approved and nothing changes.
  // It is not a status-machine change: `agent_retract` is already a non-human
  // reason, so the cross-terminal verdict guard was never going to fire on it,
  // and every other terminal status still refuses.
  const isDisarm =
    mode === "retract" && artifact.status === "approved" && artifact.type === "research" &&
    artifacts.some((a) => a.type === "changeset" && (a.content as { reviewIntent?: string } | null)?.reviewIntent === "external");
  if (artifact.status !== "draft" && artifact.status !== "reviewing" && !isDisarm) {
    return {
      content: [{
        type: "text",
        text: `revise_artifact: ${artifactId} is ${artifact.status}, too late to ${mode}. Use check_feedback instead.` +
          (artifact.status === "approved" && artifact.type === "research"
            ? ` (An approved findings artifact can be retracted — "un-armed", so it can no longer be posted — only in an external PR-review session. This one has no external changeset, so approval here doesn't arm anything outbound.)`
            : ""),
      }],
      isError: true,
    };
  }
  const isObsolete = mode === "obsolete";
  const newStatus = isObsolete ? "obsolete" : "retracted";
  await store.updateArtifactStatus(artifactId, newStatus, isObsolete ? "agent_obsolete" : "agent_retract");
  await maybeUpdateTaskStatus(server, artifactId, store);
  await store.addComment({
    id: `cmt_${nanoid(10)}`,
    artifactId,
    content: `${isObsolete ? "Overcome by new information" : isDisarm ? "Un-armed (retracted after approval, so it can no longer be posted)" : "Retracted"}: ${reason}`,
    author: "agent",
  });
  broadcast({ type: "artifact_updated", artifactId, status: newStatus });
  return {
    content: [{
      type: "text",
      text: `${isObsolete
        ? `Marked ${artifactId} obsolete (overcome by new information) — it's off the human's review queue`
        : isDisarm
          ? `Un-armed ${artifactId}: it was approved, it is now retracted, and post_pr_review will exclude it. Tell your pair it will not be posted`
          : `Retracted ${artifactId}`}. Continue your workflow — call check_feedback or present a revised artifact.${await ctx.helpers.getPassiveFeedback()}`,
    }],
  };
}
