/**
 * GitHub PR review posting via the `gh` CLI.
 *
 * Why shell out instead of writing our own API client:
 *  - Senior engineers typically have `gh` installed and authenticated
 *  - gh handles token refresh, enterprise hosts, SSO, org restrictions
 *  - We'd need our own auth story otherwise
 *
 * Dependency is `gh` on PATH + authenticated (`gh auth login`). If missing,
 * we surface a clear error. No silent fallback — the user needs to know.
 */
import { spawn } from "node:child_process";
import type { GitHubReviewPayload } from "../export/format-markdown.js";
import { errorMessage } from "@deeppairing/shared";
import { parsePrReference, validRepoOwner, validRepoName } from "./pr-reference.js";

export interface PostReviewResult {
  htmlUrl: string;
  state: string;
  id: number;
  /** GitHub's immutable commit binding when the response includes it. Older
   *  fakes/proxies may omit this field, so callers that journal delivery must
   *  validate it when present without assuming it will always be echoed. */
  commitId?: string;
}

export interface PreparedPrReviewTarget {
  /** Canonical, validated github.com PR URL. */
  target: string;
  /** Read-only snapshot taken during posting preparation. This is not a lock:
   * a later push may race the review POST, so the outbound commit_id remains
   * the authoritative binding. */
  currentHeadSha: string;
}

const FULL_GIT_SHA = /^[0-9a-fA-F]{40}$/;

function canonicalSha(value: string): string | null {
  return FULL_GIT_SHA.test(value) ? value.toLowerCase() : null;
}

function requireCanonicalTarget(target: string): { owner: string; repo: string; number: number } {
  const parsed = parsePrRef(target);
  if (!parsed.owner || !parsed.repo) {
    throw new Error("A prepared review target must be a full canonical github.com pull-request URL.");
  }
  const canonical = `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
  if (target.trim().toLowerCase() !== canonical.toLowerCase()) {
    throw new Error("A prepared review target must not contain a tab, query, fragment, or non-canonical suffix.");
  }
  return { owner: parsed.owner, repo: parsed.repo, number: parsed.number };
}

export class GhMissingError extends Error {
  constructor() {
    super("The `gh` CLI is not available. Install from https://cli.github.com/ and run `gh auth login`.");
    this.name = "GhMissingError";
  }
}

export class GhNotAuthedError extends Error {
  constructor() {
    super("The `gh` CLI is installed but not authenticated. Run `gh auth login`.");
    this.name = "GhNotAuthedError";
  }
}

/**
 * Q6 (#232) — does this `gh` failure mean "you are not authenticated"?
 *
 * Both failure sites string-matched two phrases inline. That covered the
 * no-host-configured case ("not logged into any GitHub hosts") but missed the
 * one a real reviewer is at least as likely to hit: a token that EXISTS and is
 * expired, revoked, or missing the `repo` scope, where gh relays GitHub's
 * "Bad credentials (HTTP 401)" / "Requires authentication" instead. Those fell
 * through to the generic branch, so the human got a raw HTTP error where the
 * fix ("run gh auth login") is the same one sentence. One predicate, both
 * sites, all four shapes.
 */
function looksUnauthenticated(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("not logged into") ||
    lower.includes("authentication token") ||
    lower.includes("bad credentials") ||
    lower.includes("requires authentication")
  );
}

/** Parse a PR reference: "42", "#42", or a full URL → { owner?, repo?, number }. */
export function parsePrRef(ref: string): { owner?: string; repo?: string; number: number } {
  const parsed = parsePrReference(ref);
  if (parsed) return parsed;
  throw new Error(`Could not parse PR reference: "${ref}". Expected a number like "42" or a GitHub URL.`);
}

/** A gh call (network round-trip to GitHub) that hasn't returned in this long
 *  is treated as a failure rather than hanging the caller. Overridable via
 *  DEEPPAIRING_GH_TIMEOUT_MS (tests set it low). */
const GH_TIMEOUT_MS = Number(process.env.DEEPPAIRING_GH_TIMEOUT_MS) || 20000;

/** Run a command, capture stdout/stderr, return exit + both streams. Kills the
 *  child and rejects if it exceeds GH_TIMEOUT_MS — `gh` makes real network
 *  calls (token refresh, API), and a hung one must not wall-clock-hang the
 *  agent (or a test). */
function run(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(() => reject(new Error(`gh ${args[0] ?? ""} timed out after ${GH_TIMEOUT_MS}ms`)));
    }, GH_TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err: any) => {
      finish(() => {
        if (err?.code === "ENOENT") { reject(new GhMissingError()); return; }
        reject(err);
      });
    });
    child.on("close", (code) => {
      finish(() => resolve({ code: code ?? 1, stdout, stderr }));
    });
    // Q6 (#232) — EPIPE on the child's stdin must never escape.
    //
    // A review payload is easily hundreds of KB (one comment body per evidence
    // location), which is far past the ~64KB pipe buffer, so `write` completes
    // ASYNCHRONOUSLY. Every failure mode of `gh` exits BEFORE draining that
    // pipe — unauthenticated, a 422 on a closed PR, or our own SIGKILL on the
    // timeout above — and the kernel then answers the in-flight write with
    // EPIPE. An 'error' event on a stream with no listener is an UNCAUGHT
    // EXCEPTION, and this code runs inside a long-lived stdio MCP server: the
    // observable failure was not "the post failed", it was the whole server
    // going down and the agent losing its connection mid-session. Executed and
    // reproduced in post-review-e2e.test.ts ("a gh that exits without draining
    // stdin"), which fails with an unhandled error if this listener is removed.
    //
    // Swallowing is the correct response, not a papering-over: the child's own
    // 'close'/'error' handler above is already the authority on what went
    // wrong, and it reports GitHub's real message. A broken pipe here is a
    // SYMPTOM of that failure, never independent news.
    child.stdin.on("error", () => { /* see above — the child’s exit is the real story */ });
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/** Detect the current repo's owner/name using `gh repo view`. */
async function detectRepo(): Promise<{ owner: string; repo: string }> {
  const res = await run("gh", ["repo", "view", "--json", "nameWithOwner,url"]);
  if (res.code !== 0) {
    if (looksUnauthenticated(res.stderr)) throw new GhNotAuthedError();
    throw new Error(`gh repo view failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const [owner, repo] = String(parsed.nameWithOwner).split("/");
    const identity = typeof parsed.url === "string" ? parsePrReference(`${parsed.url}/pull/1`) : null;
    if (!owner || !repo || identity?.owner?.toLowerCase() !== owner.toLowerCase() ||
        identity?.repo?.toLowerCase() !== repo.toLowerCase()) {
      throw new Error("Repository detection must identify an HTTPS github.com repository; pass a full supported PR URL.");
    }
    return { owner, repo };
  } catch (err) {
    throw new Error(`Could not parse gh repo view output: ${errorMessage(err)}`);
  }
}

/** Resolve number-only refs and overrides before checking approval scope. */
export async function resolvePrTarget(ref: string, owner?: string, repo?: string): Promise<string> {
  const parsed = parsePrRef(ref);
  if ((owner !== undefined && !validRepoOwner(owner)) ||
      (repo !== undefined && !validRepoName(repo))) {
    throw new Error("Invalid GitHub owner/repo override; supply repository names, not URL components.");
  }
  const targetOwner = owner ?? parsed.owner;
  const targetRepo = repo ?? parsed.repo;
  const detected = !targetOwner || !targetRepo ? await detectRepo() : null;
  const target = `https://github.com/${targetOwner ?? detected!.owner}/${targetRepo ?? detected!.repo}/pull/${parsed.number}`;
  parsePrRef(target); // Validate detected names as well as explicit overrides.
  return target;
}

/** #343 — resolve the canonical destination and read its current head before
 * local authorization is re-read. This is deliberately preparation, not an
 * atomic compare-and-post claim: GitHub offers no lock spanning this GET and
 * the later review POST. */
export async function preparePrReviewTarget(opts: {
  ref: string;
  owner?: string;
  repo?: string;
}): Promise<PreparedPrReviewTarget> {
  const target = await resolvePrTarget(opts.ref, opts.owner, opts.repo);
  const parsed = parsePrRef(target);
  const endpoint = `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
  const res = await run("gh", [
    "api", endpoint, "--hostname", "github.com", "-H", "Accept: application/vnd.github+json", "--jq", ".head.sha",
  ]);
  if (res.code !== 0) {
    if (looksUnauthenticated(res.stderr)) throw new GhNotAuthedError();
    throw new Error(`gh api failed while reading the PR head (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const currentHeadSha = canonicalSha(res.stdout.trim());
  if (!currentHeadSha) {
    throw new Error(`Could not read a valid 40-hex head SHA for ${target}; refusing to prepare a review.`);
  }
  return { target, currentHeadSha };
}

/** #343 — perform the freshness comparison after callers have re-read local
 * authorization, then return the exact outbound payload. `commit_id` is always
 * the reviewed SHA, never the remote value observed during preparation.
 *
 * An all-legacy COMMENT/REQUEST_CHANGES can have no reviewedHeadSha and remains
 * unbound for backward compatibility. APPROVE cannot. */
export function bindReviewPayloadToPreparedTarget(
  payload: GitHubReviewPayload,
  reviewedHeadSha: string | undefined,
  prepared: PreparedPrReviewTarget,
): GitHubReviewPayload {
  if (!reviewedHeadSha) {
    if (payload.event === "APPROVE") {
      throw new Error("Refusing to post an APPROVE without an immutable reviewed head SHA.");
    }
    const { commit_id: _ignored, ...legacyPayload } = payload;
    return legacyPayload;
  }
  const canonicalReviewed = canonicalSha(reviewedHeadSha);
  if (!canonicalReviewed) {
    throw new Error("Refusing to post: the locally authorized reviewed head SHA is malformed.");
  }
  const payloadCommit = payload.commit_id ? canonicalSha(payload.commit_id) : undefined;
  if (payload.commit_id && !payloadCommit) {
    throw new Error("Refusing to post: the authorized payload contains a malformed commit SHA.");
  }
  if (payloadCommit && payloadCommit !== canonicalReviewed) {
    throw new Error("Refusing to post: the authorized payload and reviewed changeset disagree on commit SHA.");
  }
  const canonicalCurrent = canonicalSha(prepared.currentHeadSha);
  if (!canonicalCurrent) {
    throw new Error("Refusing to post: remote preparation did not return a valid 40-hex PR head SHA.");
  }
  if (canonicalCurrent !== canonicalReviewed) {
    throw new Error(
      `Refusing to post: PR ${prepared.target} changed since your pair reviewed it ` +
      `(reviewed ${canonicalReviewed.slice(0, 12)}, current ${canonicalCurrent.slice(0, 12)}). ` +
      `Fetch and present the new head, then get a fresh verdict. The current head is never substituted for the reviewed commit.`,
    );
  }
  return { ...payload, commit_id: canonicalReviewed };
}

/**
 * Post a review on a GitHub PR via `gh api`. Resolves { htmlUrl, state, id }
 * on success. Surfaces clear errors otherwise.
 */
export async function postPrReview(opts: {
  ref: string;
  payload: GitHubReviewPayload;
  /** Override repo detection (owner/repo) when the PR ref is a bare number and you want to target a specific repo. */
  owner?: string;
  repo?: string;
}): Promise<PostReviewResult> {
  const target = await resolvePrTarget(opts.ref, opts.owner, opts.repo);
  return postPreparedPrReview({ target, payload: opts.payload });
}

/** #343 — the single network-write boundary. Callers prepare the target,
 * re-read local authorization, bind the reviewed SHA, and only then call this.
 * Keeping resolution/head reads out of this function gives #344 a clean seam
 * for durable reservation immediately before the uncertain POST. */
export async function postPreparedPrReview(opts: {
  target: string;
  payload: GitHubReviewPayload;
}): Promise<PostReviewResult> {
  const parsed = requireCanonicalTarget(opts.target);
  const { owner, repo } = parsed;

  const endpoint = `repos/${owner}/${repo}/pulls/${parsed.number}/reviews`;
  const body = JSON.stringify(opts.payload);

  const res = await run(
    "gh",
    ["api", endpoint, "--hostname", "github.com", "-X", "POST", "--input", "-", "-H", "Accept: application/vnd.github+json"],
    body,
  );

  if (res.code !== 0) {
    if (looksUnauthenticated(res.stderr)) throw new GhNotAuthedError();
    throw new Error(`gh api failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }

  try {
    const parsedBody = JSON.parse(res.stdout);
    if (!parsedBody || typeof parsedBody !== "object") {
      throw new Error("response is not an object");
    }
    if (!Number.isSafeInteger(parsedBody.id) || parsedBody.id <= 0) {
      throw new Error("review id is not a positive integer");
    }
    const expectedState = opts.payload.event === "APPROVE"
      ? "APPROVED"
      : opts.payload.event === "REQUEST_CHANGES"
        ? "CHANGES_REQUESTED"
        : "COMMENTED";
    if (parsedBody.state !== expectedState) {
      throw new Error(`review state ${JSON.stringify(parsedBody.state)} does not match ${opts.payload.event}`);
    }
    if (typeof parsedBody.html_url !== "string") {
      throw new Error("review URL is missing");
    }
    let reviewUrl: URL;
    try {
      reviewUrl = new URL(parsedBody.html_url);
    } catch {
      throw new Error("review URL is malformed");
    }
    const expectedPath = `/${owner}/${repo}/pull/${parsed.number}`.toLowerCase();
    const canonicalReviewUrl =
      `https://github.com/${owner}/${repo}/pull/${parsed.number}#pullrequestreview-${parsedBody.id}`;
    if (reviewUrl.protocol !== "https:" || reviewUrl.hostname.toLowerCase() !== "github.com" ||
        reviewUrl.pathname.toLowerCase() !== expectedPath ||
        reviewUrl.hash !== `#pullrequestreview-${parsedBody.id}` ||
        parsedBody.html_url.toLowerCase() !== canonicalReviewUrl.toLowerCase()) {
      throw new Error("review URL does not identify the posted review on the prepared target");
    }
    const commitId = parsedBody.commit_id === undefined
      ? undefined
      : typeof parsedBody.commit_id === "string"
        ? canonicalSha(parsedBody.commit_id)
        : null;
    if (commitId === null) {
      throw new Error("review commit_id is malformed");
    }
    return {
      htmlUrl: reviewUrl.toString(),
      state: parsedBody.state,
      id: parsedBody.id,
      ...(commitId ? { commitId } : {}),
    };
  } catch (err) {
    throw new Error(`Posted, but could not parse gh response: ${errorMessage(err)}`);
  }
}
