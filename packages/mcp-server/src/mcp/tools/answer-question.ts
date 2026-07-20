import { nanoid } from "nanoid";
import type { ToolContext, ToolResult } from "./types.js";
import { validateSuggestionTransition, type SuggestionUpdate } from "../../store/store-interface.js";

/**
 * B3 — answer_question, extracted verbatim from the server.ts switch.
 *
 * #172 — this is ALSO the agent's response surface for a suggested edit (a
 * comment carrying a `suggestion`). The agent replies in prose (the `answer`,
 * shown as Claude's reply on the suggestion card) AND resolves the state via
 * the optional `suggestionState` arg:
 *   - "applied"   → the human's edit ships; pass `appliedInVersion` so the card
 *                   links "APPLIED IN vN". (For an insisted suggestion the state
 *                   stays "insisted" — the override record is preserved — and
 *                   only the version is stamped.)
 *   - "countered" → propose a different edit; pass the reasoning as `answer` and
 *                   optionally `counterReplacement` (your alternative code).
 * Extending answer_question (rather than adding a tool) keeps ONE "respond to
 * the human's feedback comment" surface — the reply-comment plumbing, the
 * commentId targeting, and the broadcast are all reused.
 */
export async function handleAnswerQuestion(ctx: ToolContext, args: any): Promise<ToolResult> {
  const { store, broadcast } = ctx;

  const commentId = String(args?.commentId ?? "").trim();
  const answer = String(args?.answer ?? "").trim();
  if (!commentId || !answer) {
    return {
      content: [{ type: "text", text: "answer_question requires commentId and answer." }],
      isError: true,
    };
  }

  // AA7b — getComment is required on IStore; cast was dead weight.
  const parent = await store.getComment(commentId);
  if (!parent) {
    return {
      content: [{ type: "text", text: `answer_question: no comment with id ${commentId}.` }],
      isError: true,
    };
  }

  // #172 — suggestion resolution path. The agent replies in prose AND stamps the
  // state machine. Every guard runs BEFORE the reply comment is posted so a
  // rejected transition never leaves an orphan agent reply on the card.
  const suggestionStateRaw = typeof args?.suggestionState === "string" ? args.suggestionState : undefined;
  const validState = suggestionStateRaw === "applied" || suggestionStateRaw === "countered";
  if (parent.suggestion) {
    const s = parent.suggestion;
    // A suggestion "owes a response" while the agent still has an action to
    // take: it's pending, insisted-not-yet-applied, or the human took the
    // counter (applied + counter, not yet stamped). A countered suggestion is
    // awaiting the HUMAN — the agent may plain-reply to keep talking.
    const owesResponse =
      s.appliedInVersion == null &&
      (s.state === "pending" || s.state === "insisted" || (s.state === "applied" && !!s.counter));

    // F3 — the feature's thesis: a suggestion the agent owes a response on
    // CANNOT be silently plain-answered (reply posts, suggestion stays PENDING
    // forever, check_feedback never re-delivers). Demand a suggestionState.
    if (owesResponse && !validState) {
      return {
        content: [{
          type: "text",
          text:
            `answer_question: ${commentId} is a SUGGESTED EDIT you must respond to — a plain reply is not enough (it would leave the suggestion PENDING forever). ` +
            `Call again with suggestionState: "applied" + appliedInVersion (apply verbatim, or apply-with-extension and name the change in \`answer\`), or "countered" with your reason in \`answer\`. ` +
            `[code: suggestion_response_required]`,
        }],
        isError: true,
      };
    }

    if (validState) {
      let update: SuggestionUpdate;
      if (suggestionStateRaw === "countered") {
        const counterReplacement = args?.counterReplacement != null ? String(args.counterReplacement) : undefined;
        update = { state: "countered", counter: { reason: answer, ...(counterReplacement ? { replacementText: counterReplacement } : {}) } };
      } else {
        const versionRaw = Number(args?.appliedInVersion);
        const appliedInVersion = Number.isFinite(versionRaw) && versionRaw > 0 ? Math.floor(versionRaw) : undefined;
        if (appliedInVersion == null) {
          return {
            content: [{ type: "text", text: "answer_question: applying a suggestion requires appliedInVersion (the artifact version that now contains the edit)." }],
            isError: true,
          };
        }
        // Preserve an "insisted" state (the override record) — only stamp the
        // version. Otherwise mark it applied.
        update = s.state === "insisted" ? { appliedInVersion } : { state: "applied", appliedInVersion };
      }

      // F1 / F4 — reject counter-after-insist, counter-after-applied, and a
      // second apply that would re-stamp a different version.
      const verdict = validateSuggestionTransition(s, update);
      if (!verdict.ok) {
        return {
          content: [{ type: "text", text: `answer_question: ${verdict.message} [code: ${verdict.code}]` }],
          isError: true,
        };
      }

      const replyId = `cmt_${nanoid(10)}`;
      const reply = await store.addComment({
        id: replyId,
        artifactId: parent.target?.artifactId ?? "__session__",
        content: answer,
        author: "agent",
        target: parent.target ?? { artifactId: "__session__" },
        parentCommentId: commentId,
      } as any);

      const updated = await store.updateCommentSuggestion(commentId, update);
      broadcast({ type: "comment_added", comment: reply });
      if (updated) broadcast({ type: "comment_updated", comment: updated });
      const verb = suggestionStateRaw === "countered"
        ? "Countered the suggestion"
        : `Applied the suggestion${updated?.suggestion?.appliedInVersion ? ` (in v${updated.suggestion.appliedInVersion})` : ""}`;
      return {
        content: [{ type: "text", text: `${verb} on ${commentId}. The human will see your reply on the suggestion card.${await ctx.helpers.getPassiveFeedback()}` }],
      };
    }
    // else: not owing a response + no state → a legitimate plain reply (e.g. to
    // a countered suggestion awaiting the human, or an already-applied one).
    // Fall through to the plain-answer path below.
  }

  const answerId = `cmt_${nanoid(10)}`;
  const codeRefs = Array.isArray(args?.evidence)
    ? args.evidence
        .filter((e: any) => e && typeof e === "object")
        .map((e: any) => ({
          filePath: String(e.filePath ?? ""),
          lineStart: Number(e.lineStart ?? 1),
          lineEnd: Number(e.lineEnd ?? e.lineStart ?? 1),
          snippet: e.snippet ? String(e.snippet) : undefined,
        }))
        .filter((e: any) => e.filePath)
    : undefined;

  // FN1 — pass codeReferences as a first-class param so it survives the
  // DaemonClient HTTP round-trip in production. Pre-FN1 it was mutated
  // onto the returned object, which is a throwaway copy in daemon mode →
  // the agent's code evidence never reached the store or the UI.
  const answerComment = await store.addComment({
    id: answerId,
    artifactId: parent.target?.artifactId ?? "__session__",
    content: answer,
    author: "agent",
    target: parent.target ?? { artifactId: "__session__" },
    parentCommentId: commentId,
    ...(codeRefs && codeRefs.length > 0 ? { codeReferences: codeRefs } : {}),
  } as any);

  // AA7b — markCommentAnswered is required on IStore.
  await store.markCommentAnswered(commentId, answerId);

  broadcast({ type: "comment_added", comment: answerComment });
  // O7: distinct event so the UI can toast the answer moment (otherwise
  // it just blends into the artifact's comment thread and the human
  // might not notice their question was picked up).
  broadcast({
    type: "question_answered",
    questionId: commentId,
    answerId,
    artifactId: parent.target?.artifactId,
    answerExcerpt: answer.slice(0, 120),
  });
  return {
    content: [{ type: "text", text: `Answered ${commentId}. The human will see the reply under their question.${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
