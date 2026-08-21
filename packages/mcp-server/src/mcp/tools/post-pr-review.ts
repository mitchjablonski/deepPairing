import type { ToolContext, ToolResult } from "./types.js";
import { postPrReview, GhMissingError, GhNotAuthedError } from "../../github/post-review.js";
import { authorizeReviewPost } from "../../github/review-authorization.js";

/** B3 — post_pr_review, extracted verbatim from the server.ts switch.
 *  Q6 (#232) B1 — the payload is no longer built here: it comes from
 *  authorizeReviewPost, which refuses unless the human's recorded verdicts in
 *  the session store authorize the post. Same gate the CLI door uses. */
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

  // Q6 B1 — authorize BEFORE anything leaves the machine. The human's approvals
  // in the store are the permission; there is no flag that bypasses this.
  const state = await store.getFullState();
  const auth = authorizeReviewPost(state as never, { event });
  if (!auth.ok) {
    return { content: [{ type: "text", text: auth.reason }], isError: true };
  }
  const { payload } = auth;

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
        // APPROVE the gate above allows; say what actually happened.
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
