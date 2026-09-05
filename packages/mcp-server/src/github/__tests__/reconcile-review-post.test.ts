import { expect, it } from "vitest";
import { verifyReconciledReview } from "../reconcile-review-post.js";
import { reviewPostMarker } from "../durable-review-post.js";
import { reviewPostDigest, type ReviewPostOperation } from "../../store/review-post-journal.js";

const sha = "a".repeat(40);
const target = "https://github.com/acme/widget/pull/12";
const id = "bb2a05cd-d7da-4a1f-b7fb-1fabdd53dc73";
const payload = { body: "Reviewed", event: "COMMENT" as const, commit_id: sha,
  comments: [{ path: "src/a.ts", body: "Fix the race", line: 3, side: "RIGHT" as const }] };
const operation: ReviewPostOperation = {
  id, sessionId: "s", tokenDigest: "b".repeat(64), state: "unknown",
  createdAt: "2026-09-04T12:00:00Z", updatedAt: "2026-09-04T12:00:00Z",
  identity: { target, event: "COMMENT", reviewedHeadSha: sha, payloadDigest: reviewPostDigest(payload), authorizationDigest: "c".repeat(64) },
};
const review = { id: 7, body: payload.body + reviewPostMarker(id), html_url: `${target}#pullrequestreview-7`,
  commit_id: sha, state: "COMMENTED", submitted_at: "2026-09-04T12:01:00Z" };
const comments = [{ id: 9, pull_request_review_id: 7, path: "src/a.ts", body: "Fix the race", side: "RIGHT",
  original_line: 3, original_commit_id: sha, line: null }];

it("verifies a marked review against original coordinates even after the diff moved", () => {
  expect(verifyReconciledReview(operation, review, comments)).toMatchObject({ id: 7, commitId: sha });
});

it.each([
  { ...review, body: payload.body },
  { ...review, body: payload.body + reviewPostMarker("cc2a05cd-d7da-4a1f-b7fb-1fabdd53dc73") },
  { ...review, body: "Edited" + reviewPostMarker(id) },
  { ...review, commit_id: "d".repeat(40) },
  { ...review, html_url: "https://github.com/wrong/repo/pull/12#pullrequestreview-7" },
  { ...review, state: "APPROVED" },
])("refuses a mismatched remote review without weakening uncertainty: %j", candidate => {
  expect(() => verifyReconciledReview(operation, candidate, comments)).toThrow();
});

it.each([
  [], [comments[0], comments[0]], [{ ...comments[0], body: "edited" }],
  [{ ...comments[0], original_line: undefined }], [{ ...comments[0], original_commit_id: "d".repeat(40) }],
  [{ ...comments[0], pull_request_review_id: 8 }], [{ ...comments[0], in_reply_to_id: 1 }],
  [{ ...comments[0], original_start_line: 2 }],
].map(value => [value]))("refuses missing, edited, duplicated or foreign inline comments %j", candidate => {
  expect(() => verifyReconciledReview(operation, review, candidate)).toThrow();
});

it("does not reconcile a cancelled or never-sent operation", () => {
  expect(() => verifyReconciledReview({ ...operation, state: "reserved" }, review, comments)).toThrow();
});
