import { nanoid } from "nanoid";
import { collectUnansweredQuestions } from "@deeppairing/shared";
import { maybeUpdateTaskStatus } from "../tasks-probe.js";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * G1 (#198c) — withdraw_artifact: the agent RETRACTS its own draft.
 *
 * A focused, single-purpose verb (distinct from revise_artifact's three modes):
 * "I presented this, but on reflection it shouldn't stand — take it back." Valid
 * ONLY on the calling session's own artifact while it is still `draft`, and it
 * requires a one-line `reason` (so the withdrawal is legible in the history and
 * the successor thread).
 *
 * THE LOAD-BEARING GUARD: a withdrawal must NEVER be a way to DODGE feedback. If
 * the draft carries unanswered human questions (the persisted tail-walk,
 * collectUnansweredQuestions) OR undrained human comments (acknowledged=false —
 * the agent hasn't even seen them via check_feedback yet), the withdrawal is
 * REJECTED with an error telling the agent to answer first. Only once the draft
 * is feedback-clean may it be withdrawn.
 *
 * Sets status `retracted` (already in the schema; export + REVIEWABLE parity
 * treat it as not-built / not-pending automatically since those key on
 * status==="draft"). NEVER writes the cross-project ledger (a mistake isn't a
 * philosophy signal). Comments carry to a successor via the existing parentId
 * chain when the agent later presents a replacement.
 */
export async function handleWithdrawArtifact(ctx: ToolContext, args: any): Promise<ToolResult> {
  const { store, server, broadcast } = ctx;

  const artifactId = typeof args?.artifactId === "string" ? args.artifactId : "";
  const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
  if (!artifactId) {
    return {
      content: [{ type: "text", text: `withdraw_artifact: an \`artifactId\` is required (the id of your own draft to retract).` }],
      isError: true,
    };
  }
  if (!reason) {
    return {
      content: [{ type: "text", text: `withdraw_artifact: a one-line \`reason\` is required — say WHY you're taking ${artifactId} back so the history and any successor read honestly.` }],
      isError: true,
    };
  }

  const artifacts = await store.getArtifacts();
  const artifact = artifacts.find((a) => a.id === artifactId);
  if (!artifact) {
    // Session ownership is implicit: getArtifacts() is scoped to the calling
    // session's store, so an artifact from another session simply isn't here.
    return {
      content: [{ type: "text", text: `withdraw_artifact: no artifact with id ${artifactId} in this session. You can only withdraw your OWN draft.` }],
      isError: true,
    };
  }
  if (artifact.status !== "draft") {
    return {
      content: [{ type: "text", text: `withdraw_artifact: ${artifactId} is ${artifact.status}, not a draft — withdrawal only applies to a draft you haven't heard back on. Use revise_artifact (supersede) to version it, or check_feedback to read its verdict.` }],
      isError: true,
    };
  }

  // THE LOAD-BEARING GUARD — never dodge review. Reject if the draft carries
  // unanswered human questions or undrained human comments.
  const comments = await store.getCommentsForArtifact(artifactId);
  const unanswered = collectUnansweredQuestions(comments).filter(
    (q) => q.artifactId === artifactId || q.question.target?.artifactId === artifactId,
  );
  const undrainedComments = comments.filter((c) => c.author === "human" && !c.acknowledged);
  if (unanswered.length > 0 || undrainedComments.length > 0) {
    const bits: string[] = [];
    if (unanswered.length > 0) bits.push(`${unanswered.length} unanswered question${unanswered.length === 1 ? "" : "s"}`);
    if (undrainedComments.length > 0) bits.push(`${undrainedComments.length} unread comment${undrainedComments.length === 1 ? "" : "s"}`);
    return {
      content: [{
        type: "text",
        text:
          `withdraw_artifact: REFUSED — ${artifactId} has ${bits.join(" and ")} from the human. ` +
          `Withdrawing must never dodge review. Call check_feedback and answer_question to address the feedback first; then withdraw (or revise) with a clear conscience.`,
      }],
      isError: true,
    };
  }

  // Stamp the reason onto content FIRST so it's present when the status flip
  // broadcasts the retracted state (the panel renders "↩ Retracted by agent —
  // <reason>" inline). It ALSO rides an agent comment below for thread history.
  await store.setRetractReason?.(artifactId, reason);
  await store.updateArtifactStatus(artifactId, "retracted", "agent_withdraw");
  await maybeUpdateTaskStatus(server, artifactId, store);
  // An agent-authored THREAD MARKER so the history reads honestly and a successor
  // can thread onto it. #204 (UX L1) — the marker is now just "Withdrawn." (the
  // reason is NOT repeated here): the inline "↩ Retracted by agent — <reason>"
  // status surface already carries the reason ~150px away, so echoing the full
  // sentence in an adjacent agent comment was the same words twice. The inline
  // reason is the honest status surface (kept); this comment is only the thread
  // marker that lets a successor chain onto the retraction.
  await store.addComment({
    id: `cmt_${nanoid(10)}`,
    artifactId,
    content: `Withdrawn.`,
    author: "agent",
  });
  broadcast({ type: "artifact_updated", artifactId, status: "retracted" });
  return {
    content: [{
      type: "text",
      text:
        `Withdrew ${artifactId} — "${reason}". It's off the human's review queue and recorded as retracted (not built). ` +
        `Nothing was written to the ledger. Continue your workflow, or present a corrected artifact when ready.${await ctx.helpers.getPassiveFeedback()}`,
    }],
  };
}
