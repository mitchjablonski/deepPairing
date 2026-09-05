import { z } from "zod";
import { reviewPostMarker } from "./durable-review-post.js";
import { reviewPostDigest, validateReviewPostResult, type ReviewPostOperation } from "../store/review-post-journal.js";

const reviewSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  body: z.string(), html_url: z.string(), state: z.string(),
  commit_id: z.string().regex(/^[0-9a-fA-F]{40}$/),
  submitted_at: z.iso.datetime(),
});
const commentSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pull_request_review_id: z.number().int().positive(),
  path: z.string().min(1), body: z.string(), side: z.enum(["LEFT", "RIGHT"]),
  original_line: z.number().int().positive(),
  original_commit_id: z.string().regex(/^[0-9a-fA-F]{40}$/),
  in_reply_to_id: z.number().optional(),
  original_start_line: z.number().nullable().optional(),
});

/** Verify an explicitly selected remote review; never infer that an absent or
 * mismatching result means the uncertain send failed. The caller supplies ALL
 * comment pages, without filtering, and keeps the operation unresolved on error. */
export function verifyReconciledReview(operation: ReviewPostOperation, rawReview: unknown, rawComments: unknown) {
  if (!["sending", "unknown", "succeeded"].includes(operation.state)) {
    throw new Error("Only a possibly sent operation can be reconciled to a remote review");
  }
  const review = reviewSchema.parse(rawReview);
  const marker = reviewPostMarker(operation.id);
  if (!review.body.endsWith(marker)) throw new Error("Remote review does not carry this operation's correlation marker");
  const comments = z.array(commentSchema).max(2000).parse(rawComments);
  const seen = new Set<number>();
  for (const comment of comments) {
    if (seen.has(comment.id) || comment.pull_request_review_id !== review.id ||
        comment.in_reply_to_id !== undefined || comment.original_start_line != null ||
        comment.original_commit_id.toLowerCase() !== review.commit_id.toLowerCase()) {
      throw new Error("Remote inline comments do not match the original review submission");
    }
    seen.add(comment.id);
  }
  const payload = {
    body: review.body.slice(0, -marker.length), event: operation.identity.event,
    comments: comments.map(comment => ({ path: comment.path, body: comment.body, line: comment.original_line, side: comment.side })),
    ...(operation.identity.reviewedHeadSha ? { commit_id: review.commit_id.toLowerCase() } : {}),
  };
  if (reviewPostDigest(payload) !== operation.identity.payloadDigest) {
    throw new Error("Remote review content differs from the reserved payload; preserve uncertainty and inspect it");
  }
  return validateReviewPostResult(operation.identity, {
    id: review.id, htmlUrl: review.html_url, state: review.state, commitId: review.commit_id.toLowerCase(),
  });
}
