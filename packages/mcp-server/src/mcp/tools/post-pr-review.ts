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

  if (payload.comments.length === 0) {
    return {
      content: [{
        type: "text",
        text: "No findings with structured evidence (filePath + lineStart) in this session — nothing to post as inline review comments. Use present_findings with structured Evidence objects to enable this.",
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
        text: `Posted ${payload.comments.length} inline comment${payload.comments.length === 1 ? "" : "s"} on PR ${ref} as ${payload.event}: ${result.htmlUrl}`,
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
