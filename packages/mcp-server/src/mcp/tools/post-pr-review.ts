import type { ToolContext, ToolResult } from "./types.js";
import { buildGitHubReviewPayload } from "../../export/format-markdown.js";
import { postPrReview, GhMissingError, GhNotAuthedError } from "../../github/post-review.js";

/** B3 — post_pr_review, extracted verbatim from the server.ts switch. */
export async function handlePostPrReview(ctx: ToolContext, args: any): Promise<ToolResult> {
  const { store } = ctx;

  const ref = String(args?.pr ?? "").trim();
  if (!ref) {
    return {
      content: [{ type: "text", text: "post_pr_review requires a `pr` argument (number or URL)." }],
      isError: true,
    };
  }
  const event = ["COMMENT", "REQUEST_CHANGES", "APPROVE"].includes(args?.event)
    ? (args.event as "COMMENT" | "REQUEST_CHANGES" | "APPROVE")
    : "COMMENT";

  // Build the payload from the current session.
  const state = await store.getFullState();
  const payload = buildGitHubReviewPayload(state as any, { event });

  // Q6 (#232) — the empty-comments guard, narrowed to the cases where it is
  // actually right.
  //
  // Refusing every zero-comment post made the MOST COMMON outcome of a real PR
  // review impossible: reading a colleague's change, finding nothing wrong, and
  // approving it. "I looked, it's fine" is a complete review — GitHub treats a
  // bare APPROVE as a first-class verdict, and it is the one the reviewer is
  // asked for. The tool refused it and told them to go write findings.
  //
  // The guard stays for the other two events, where it is still correct: a
  // COMMENT review with nothing to say posts noise, and REQUEST_CHANGES with no
  // comment blocks a colleague without telling them what to change. Those are
  // genuine mistakes, and the message names the fix.
  if (payload.comments.length === 0 && payload.event !== "APPROVE") {
    return {
      content: [{
        type: "text",
        text:
          `No findings with structured evidence (filePath + lineStart) in this session — nothing to post as ${payload.event === "REQUEST_CHANGES" ? "the inline comments a REQUEST_CHANGES owes the author" : "inline review comments"}. ` +
          "Use present_findings with structured Evidence objects to enable this" +
          (payload.event === "REQUEST_CHANGES" ? "" : ", or pass event: \"APPROVE\" if the human read it and had nothing to flag") +
          ".",
      }],
      isError: true,
    };
  }

  try {
    const result = await postPrReview({
      ref,
      payload,
      owner: typeof args?.owner === "string" ? args.owner : undefined,
      repo: typeof args?.repo === "string" ? args.repo : undefined,
    });
    return {
      content: [{
        type: "text",
        // Q6 — "Posted 0 inline comments" is a nonsense sentence for the bare
        // APPROVE the guard above now allows; say what actually happened.
        text: payload.comments.length === 0
          ? `Posted a review on PR ${ref} as ${payload.event} with no inline comments: ${result.htmlUrl}`
          : `Posted ${payload.comments.length} inline comment${payload.comments.length === 1 ? "" : "s"} on PR ${ref} as ${payload.event}: ${result.htmlUrl}`,
      }],
    };
  } catch (err: any) {
    if (err instanceof GhMissingError || err instanceof GhNotAuthedError) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `post_pr_review failed: ${err?.message ?? err}` }],
      isError: true,
    };
  }
}
