/**
 * R1 (#279) — the record of reviews this session has ALREADY posted to GitHub.
 *
 * Round 13 called `post_pr_review` five times in a row and got five separate
 * reviews on the same pull request, each one notifying the author. GitHub's
 * review endpoint is not idempotent and nothing on this side made it so.
 *
 * Shape of the fix: a per-session sidecar (`posted-reviews.json`, exactly like
 * `annotations.json` / `preflight-traces.json`) rather than a field on an
 * artifact. A post is an EVENT about the outside world, not a revision of any
 * artifact — and the record has to survive a process restart and be readable
 * from the OTHER door (the CLI runs in its own process), which rules out the
 * in-memory present-idempotency registry.
 *
 * The record is deliberately thin: what was posted, where, and when. It is
 * never sent anywhere — it exists so the second call can refuse.
 */
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { parsePrReference } from "../github/pr-reference.js";

export interface PostedReviewRecord {
  /** The PR reference as the caller gave it ("42", "#42", or a full URL). */
  pr: string;
  /** Parsed PR number — the stable half of the identity check. */
  prNumber: number;
  /** Present only when the ref carried them (a URL) or the caller overrode. */
  owner?: string;
  repo?: string;
  event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
  /** GitHub's review id + html_url, straight off the API response. */
  reviewId: number;
  url: string;
  postedAt: string;
  /** How many inline comments went with it — for the refusal message. */
  commentCount: number;
}

/** Where a session's posted-review sidecar lives. */
export function postedReviewsPath(projectRoot: string, sessionId: string): string {
  return path.join(projectRoot, ".deeppairing", "sessions", sessionId, "posted-reviews.json");
}

/**
 * Is `record` a post to the same pull request as `ref`?
 *
 * Matched on the PR NUMBER, plus owner/repo when BOTH sides carry them. A bare
 * "42" and "https://github.com/acme/widgets/pull/42" are the same PR from the
 * same session — the session is bound to one project, and the round-13 repeat
 * came from re-issuing the identical call, so number-matching is the behaviour
 * that actually catches it. Different owner/repo on both sides (the same number
 * in two different repos, posted from one session) correctly does NOT match.
 */
export function samePrTarget(record: PostedReviewRecord, ref: string): boolean {
  const parsed = parsePrNumber(ref);
  if (parsed === null || parsed.number !== record.prNumber) return false;
  if (parsed.owner && parsed.repo && record.owner && record.repo) {
    return parsed.owner.toLowerCase() === record.owner.toLowerCase() &&
      parsed.repo.toLowerCase() === record.repo.toLowerCase();
  }
  return true;
}

/** A local, throw-free PR-ref parse. github/post-review.ts has the strict
 *  parser (it THROWS on a bad ref, which is right at the call site); this one
 *  is used for matching, where "unparseable" just means "no match". */
export function parsePrNumber(ref: string): { owner?: string; repo?: string; number: number } | null {
  return parsePrReference(ref);
}

/** Read the sidecar. Absent or corrupt → empty: a lost record can only cause a
 *  duplicate post to be *allowed*, never a legitimate one to be refused, so
 *  failing open here is the safe direction (the human's verdict checks, which
 *  fail CLOSED, are untouched by this file). */
export function readPostedReviews(projectRoot: string, sessionId: string): PostedReviewRecord[] {
  try {
    const raw = fs.readFileSync(postedReviewsPath(projectRoot, sessionId), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PostedReviewRecord[]) : [];
  } catch {
    return [];
  }
}

/** Append one record, atomically. Returns the full list. */
export function appendPostedReview(
  projectRoot: string,
  sessionId: string,
  record: PostedReviewRecord,
): PostedReviewRecord[] {
  const all = readPostedReviews(projectRoot, sessionId);
  all.push(record);
  writeJsonAtomic(postedReviewsPath(projectRoot, sessionId), all);
  return all;
}
