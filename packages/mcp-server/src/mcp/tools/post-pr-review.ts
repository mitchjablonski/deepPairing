import type { ToolContext, ToolResult } from "./types.js";
import {
  postPreparedPrReview,
  preparePrReviewTarget,
  parsePrRef,
  GhMissingError,
  GhNotAuthedError,
} from "../../github/post-review.js";
import { authorizeReviewPost } from "../../github/review-authorization.js";
import { errorMessage } from "@deeppairing/shared";
import { authorizeDurableReview } from "../../github/authorized-durable-review.js";
import { executeDurableReviewPost } from "../../github/durable-review-post.js";

/** B3 — post_pr_review, extracted verbatim from the server.ts switch.
 *  Q6 (#232) B1 — the payload is no longer built here: it comes from
 *  authorizeReviewPost, which refuses unless the human's recorded verdicts in
 *  the session store authorize the post. Same gate the CLI door uses.
 *
 *  R1 (#279) — this door no longer whitelists the event itself. Normalization
 *  lives INSIDE authorizeReviewPost, because there are two doors and only one
 *  of them used to do it: the CLI passed `(event as any) || "COMMENT"` straight
 *  through, so lowercase "approve" reached the gate and slid past its
 *  `event === "APPROVE"` comparison — taking the APPROVE authorization with it.
 *  One normalizer, both doors, no drift. */
export async function handlePostPrReview(ctx: ToolContext, args: any): Promise<ToolResult> {
  const { store } = ctx;

  const ref = String(args?.pr ?? "").trim();
  if (!ref) {
    return {
      content: [{ type: "text", text: "post_pr_review requires a `pr` argument (number or URL)." }],
      isError: true,
    };
  }

  // Q6 B1 — authorize BEFORE anything leaves the machine. The human's approvals
  // in the store are the permission; there is no flag that bypasses this.
  // (R1 — `repost` is NOT such a flag: it re-arms a post the human already
  // authorized once and which the gate is refusing only as a duplicate. Every
  // verdict check still runs.)
  const state = await store.getFullState();
  const auth = authorizeReviewPost(state as never, {
    event: args?.event,
    pr: ref,
    repost: args?.repost === true,
  });
  if (!auth.ok) {
    return { content: [{ type: "text", text: auth.reason }], isError: true };
  }
  try {
    // #343 — preparation is read-only: resolve the canonical destination and
    // observe its current head. It intentionally happens BEFORE the final local
    // authorization read, so a verdict/content edit during the network wait is
    // rebuilt into (or removes authorization from) the actual outbound payload.
    const prepared = await preparePrReviewTarget({
      ref,
      ...(typeof args?.owner === "string" ? { owner: args.owner } : {}),
      ...(typeof args?.repo === "string" ? { repo: args.repo } : {}),
    });
    const target = prepared.target;
    const options = { event: args?.event, repost: args?.repost === true };
    const { payload, identity } = authorizeDurableReview(await store.getFullState() as never, options, prepared);
    const posted = await executeDurableReviewPost({
      store: store.reviewPosts, payload, identity, repost: options.repost,
      reauthorize: async () => authorizeDurableReview(await store.getFullState() as never, options, prepared).identity,
      send: (canonicalTarget, frozenPayload) => postPreparedPrReview({ target: canonicalTarget, payload: frozenPayload }),
    });
    const { result } = posted;
    // R1 (#279) — record the landed review BEFORE reporting success, so a
    // second call refuses instead of notifying the author again. Awaited (not
    // fire-and-forget): if the stamp fails, the agent should hear about it in
    // the same breath as the URL, because the next call will be allowed
    // through. Never fatal — the review IS posted, and saying otherwise would
    // send the agent to re-post it.
    let stampNote = posted.receipt === "unconfirmed"
      ? ` Review ${posted.operationId} posted, but its durable receipt is unconfirmed. Do not retry or repost; reconcile this operation first.`
      : "";
    try {
      const parsed = parsePrRef(target);
      const owner = parsed.owner;
      const repo = parsed.repo;
      await store.recordPostedReview({
        pr: ref,
        prNumber: parsed.number,
        ...(owner ? { owner } : {}),
        ...(repo ? { repo } : {}),
        event: payload.event,
        reviewId: result.id,
        url: result.htmlUrl,
        postedAt: new Date().toISOString(),
        commentCount: payload.comments.length,
      });
    } catch (stampErr) {
      stampNote += ` (Legacy history update failed — ${errorMessage(stampErr)}. The durable journal still prevents another post.)`;
    }
    return {
      content: [{
        type: "text",
        // Q6 — "Posted 0 inline comments" is a nonsense sentence for the bare
        // APPROVE the gate above allows; say what actually happened.
        text: (payload.comments.length === 0
          ? `Posted a review on PR ${ref} as ${payload.event} with no inline comments: ${result.htmlUrl}`
          : `Posted ${payload.comments.length} inline comment${payload.comments.length === 1 ? "" : "s"} on PR ${ref} as ${payload.event}: ${result.htmlUrl}`)
          + ` Give your pair the URL. This session will refuse a second post to this PR unless they ask you to post again.`
          + stampNote,
      }],
    };
  } catch (err) {
    if (err instanceof GhMissingError || err instanceof GhNotAuthedError) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `post_pr_review failed: ${errorMessage(err)}` }],
      isError: true,
    };
  }
}
