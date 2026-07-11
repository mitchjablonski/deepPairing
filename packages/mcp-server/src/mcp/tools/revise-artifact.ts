import { nanoid } from "nanoid";
import type { DecisionOption } from "@deeppairing/shared";
import type { ToolContext, ToolResult } from "./types.js";
import { notifyResourcesListChanged } from "../tool-helpers.js";
import { maybeUpdateTaskStatus } from "../tasks-probe.js";
import { scanContentForSecrets } from "../../secret-scan.js";
import {
  validatePresentFindingsInput,
  validatePresentSpecInput,
  validatePresentPlanInput,
  validatePresentOptionsInput,
  validatePresentCodeChangeInput,
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
    const content = (args?.content && typeof args.content === "object") ? args.content : null;
    if (!content) {
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
    // #158 — re-scan the REVISED content for secret shapes. Supersede creates
    // a brand-new artifact, so without this a v2 would silently drop a v1's
    // persisted secretWarnings (or miss a secret pasted into the revision).
    // Generic string-leaf walk (not the present_* curated blob lists) because
    // this path handles every artifact type.
    const secretMatches = scanContentForSecrets(content);
    const newArtifact = await store.createArtifact({
      id: newId,
      type: old.type,
      title,
      content: content as Record<string, unknown>,
      agentReasoning: reason,
      parentId: old.id,
      version: old.version + 1,
      ...(secretMatches.length > 0 ? { secretWarnings: secretMatches } : {}),
      // Bug4 — carry the old version's relatedArtifactIds onto v2 so the
      // reference graph doesn't dangle at the SOURCE when v1 is superseded
      // (belt-and-suspenders with the client-side resolveToLiveId in the flow
      // sidebar). Optional field; only set when the old artifact had refs.
      ...(old.relatedArtifactIds ? { relatedArtifactIds: old.relatedArtifactIds } : {}),
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

    broadcast({ type: "artifact_created", artifact: newArtifact });
    broadcast({ type: "artifact_updated", artifactId: old.id, status: "superseded" });
    // HH10 — supersede creates a new resource AND retires the old
    // one's content. Both are list-changing events.
    notifyResourcesListChanged(server);

    return {
      content: [{ type: "text", text: `Superseded ${artifactId} → ${newId} (v${old.version + 1}). Draft is awaiting review.${await ctx.helpers.getPassiveFeedback()}` }],
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
  if (artifact.status !== "draft" && artifact.status !== "reviewing") {
    return {
      content: [{ type: "text", text: `revise_artifact: ${artifactId} is ${artifact.status}, too late to ${mode}. Use check_feedback instead.` }],
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
    content: `${isObsolete ? "Overcome by new information" : "Retracted"}: ${reason}`,
    author: "agent",
  });
  broadcast({ type: "artifact_updated", artifactId, status: newStatus });
  return {
    content: [{ type: "text", text: `${isObsolete ? `Marked ${artifactId} obsolete (overcome by new information) — it's off the human's review queue` : `Retracted ${artifactId}`}. Continue your workflow — call check_feedback or present a revised artifact.${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
