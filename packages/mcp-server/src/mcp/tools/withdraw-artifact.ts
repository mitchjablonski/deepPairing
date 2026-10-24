import { retirementFailure } from "../../store/retirement.js";
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
 * the draft carries unanswered human questions (the persisted per-question rule,
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
  if (!store.retireArtifact) return { content: [{ type: "text", text: "withdraw_artifact: guarded retirement unavailable; nothing changed." }], isError: true };
  const outcome = await store.retireArtifact({ artifactId, expectedVersion: artifact.version, expectedStatus: artifact.status, door: "withdraw", mode: "retract", reason });
  if (outcome.kind !== "committed" && outcome.kind !== "already_retired") return { content: [{ type: "text", text: `withdraw_artifact: ${retirementFailure(outcome)}` }], isError: true };

  // The authoritative operation persisted the reason/status/root marker first.
  let taskWarning = "";
  try { await maybeUpdateTaskStatus(server, artifactId, store); }
  catch { taskWarning = " Retirement persisted, but the task summary could not be refreshed."; }
  if (outcome.kind === "committed") broadcast({ type: "artifact_updated", artifactId, status: "retracted" });
  // Retirement never drains session-wide feedback as a side effect.
  return {
    content: [{
      type: "text",
      text:
        `Withdrew ${artifactId} — "${reason}". It's off the human's review queue and recorded as retracted (not built). ` +
        `Nothing was written to the ledger. Call check_feedback for feedback still owed; withdrawal did not acknowledge or answer it.${outcome.warning ? ` ${outcome.warning}` : ""}${taskWarning}`,
    }],
  };
}
