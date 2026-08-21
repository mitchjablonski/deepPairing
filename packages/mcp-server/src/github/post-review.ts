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

export interface PostReviewResult {
  htmlUrl: string;
  state: string;
  id: number;
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
  const urlMatch = ref.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    // `!` safe: group 3 is a required capture — a match always carries it.
    return { owner: urlMatch[1], repo: urlMatch[2], number: parseInt(urlMatch[3]!, 10) };
  }
  const numMatch = ref.replace(/^#/, "").match(/^(\d+)$/);
  if (numMatch) {
    // `!` safe: group 1 is a required capture — a match always carries it.
    return { number: parseInt(numMatch[1]!, 10) };
  }
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
  const res = await run("gh", ["repo", "view", "--json", "nameWithOwner"]);
  if (res.code !== 0) {
    if (looksUnauthenticated(res.stderr)) throw new GhNotAuthedError();
    throw new Error(`gh repo view failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const [owner, repo] = String(parsed.nameWithOwner).split("/");
    if (!owner || !repo) throw new Error("gh repo view returned unexpected shape");
    return { owner, repo };
  } catch (err: any) {
    throw new Error(`Could not parse gh repo view output: ${err?.message ?? err}`);
  }
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
  const parsed = parsePrRef(opts.ref);
  let owner = opts.owner ?? parsed.owner;
  let repo = opts.repo ?? parsed.repo;

  if (!owner || !repo) {
    const detected = await detectRepo();
    owner = detected.owner;
    repo = detected.repo;
  }

  const endpoint = `repos/${owner}/${repo}/pulls/${parsed.number}/reviews`;
  const body = JSON.stringify(opts.payload);

  const res = await run(
    "gh",
    ["api", endpoint, "-X", "POST", "--input", "-", "-H", "Accept: application/vnd.github+json"],
    body,
  );

  if (res.code !== 0) {
    if (looksUnauthenticated(res.stderr)) throw new GhNotAuthedError();
    throw new Error(`gh api failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }

  try {
    const parsedBody = JSON.parse(res.stdout);
    return {
      htmlUrl: parsedBody.html_url ?? "",
      state: parsedBody.state ?? "COMMENTED",
      id: parsedBody.id ?? 0,
    };
  } catch (err: any) {
    throw new Error(`Posted, but could not parse gh response: ${err?.message ?? err}`);
  }
}
