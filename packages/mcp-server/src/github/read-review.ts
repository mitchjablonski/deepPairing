/**
 * The GET-only half of the `gh` boundary: the child-process runner, the
 * canonical-target check, and the read used to reconcile an uncertain review
 * post against evidence the operator found on the PR.
 *
 * Split out of `post-review.ts` for distribution (#344, Astra's review of
 * #383). The marketplace plugin bundle ships an operator recovery entry, and
 * `reconcile` has to be in it — a person who has independently identified the
 * remote review must be able to record that verified outcome with the tool
 * they were shipped, rather than being told to accept duplicate risk or
 * install the source tree. Importing it from `post-review.ts` would have
 * carried `postPreparedPrReview` and the payload builder into that bundle, so
 * the boundary moves here instead: dependencies point post-review → read-review
 * and never back, and nothing in this module can submit a review.
 *
 * `post-review.ts` re-exports the public names, so every existing caller is
 * unchanged.
 */
import { spawn } from "node:child_process";
import { parsePrReference } from "./pr-reference.js";

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

/** Parse a PR reference: "42", "#42", or a full URL → { owner?, repo?, number }. */
export function parsePrRef(ref: string): { owner?: string; repo?: string; number: number } {
  const parsed = parsePrReference(ref);
  if (parsed) return parsed;
  throw new Error(`Could not parse PR reference: "${ref}". Expected a number like "42" or a GitHub URL.`);
}

export function requireCanonicalTarget(target: string): { owner: string; repo: string; number: number } {
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

/** A gh call (network round-trip to GitHub) that hasn't returned in this long
 *  is treated as a failure rather than hanging the caller. Overridable via
 *  DEEPPAIRING_GH_TIMEOUT_MS (tests set it low). */
const GH_TIMEOUT_MS = Number(process.env.DEEPPAIRING_GH_TIMEOUT_MS) || 20000;

/** Run a command, capture stdout/stderr, return exit + both streams. Kills the
 *  child and rejects if it exceeds GH_TIMEOUT_MS — `gh` makes real network
 *  calls (token refresh, API), and a hung one must not wall-clock-hang the
 *  agent (or a test). */
export function run(
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

/** Read-only recovery for an explicitly selected review. Bounded pagination;
 * unavailable or incomplete evidence must never release an uncertain operation. */
export async function readReviewForReconciliation(target: string, reviewId: number): Promise<{ review: unknown; comments: unknown[] }> {
  const { owner, repo, number } = requireCanonicalTarget(target);
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0) throw new Error("Invalid remote review ID");
  const endpoint = `repos/${owner}/${repo}/pulls/${number}/reviews/${reviewId}`;
  const read = async (url: string): Promise<unknown> => {
    const res = await run("gh", ["api", url, "--hostname", "github.com", "-X", "GET", "-H", "Accept: application/vnd.github+json"]);
    if (res.code !== 0) throw new Error(`Could not verify remote review (gh exit ${res.code}); operation remains unresolved`);
    if (res.stdout.length > 8 * 1024 * 1024) throw new Error("Remote recovery response exceeds safety limit");
    return JSON.parse(res.stdout);
  };
  const review = await read(endpoint);
  const comments: unknown[] = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await read(`${endpoint}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(rows) || rows.length > 100) throw new Error("Invalid remote review comment page");
    comments.push(...rows);
    if (rows.length < 100) return { review, comments };
  }
  throw new Error("Remote review pagination exceeds safety limit; operation remains unresolved");
}
