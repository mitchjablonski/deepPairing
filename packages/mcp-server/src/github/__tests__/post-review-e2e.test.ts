/**
 * Q6 (#232) — post_pr_review, EXECUTED.
 *
 * The round-12 claims audit found this was the one tool nobody had ever run.
 * `buildGitHubReviewPayload` and `parsePrRef` had unit tests (post-review.test.ts);
 * everything downstream of them — the `gh` spawn, the argv, what actually lands
 * on stdin, repo detection, every error branch, and the tool handler that wires
 * the three together — was dead-reckoned from the docs and never once executed.
 *
 * So this suite runs the real code path end to end against a FAKE `gh` binary:
 * a real executable, first on PATH, that records every argv + stdin it receives
 * and replies with real GitHub response shapes. Not a spy on our own module —
 * the actual `spawn("gh", …)` runs, the actual pipe carries the actual JSON.
 * Nothing here touches the network; there is no GitHub token in this process and
 * a real `gh` is never invoked. (Manual verification against a live PR is a
 * step for the human — see the PR body.)
 *
 * The fake's replies are copied from GitHub's documented shapes and from what
 * `gh` really prints on failure, because the error branches are string-matched
 * ("not logged into") and a mock that echoes our own assumptions would prove
 * nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  bindReviewPayloadToPreparedTarget,
  postPreparedPrReview,
  postPrReview,
  GhMissingError,
  GhNotAuthedError,
} from "../post-review.js";
import { buildGitHubReviewPayload, type GitHubReviewPayload } from "../../export/format-markdown.js";
import { handlePostPrReview } from "../../mcp/tools/post-pr-review.js";
import type { Artifact } from "@deeppairing/shared";
import { ReviewPostJournal } from "../../store/review-post-journal.js";
import { reconcileReviewPostCommand } from "../../cli/review-posts.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore } from "../../__tests__/global-store-fixture.js";

// --- the fake gh -------------------------------------------------------------

/** Where the fake lives, and where it appends its call log. Both under the OS
 *  temp dir (native fs) — a repo-relative path on a WSL /mnt/c checkout cannot
 *  be reliably chmod +x. */
let binDir: string;
let logPath: string;
let originalPath: string | undefined;

/** The fake's behaviour, switched per-test through the environment (the fake is
 *  a separate process, so env is the only channel). */
type Mode =
  | "ok"
  | "recovery-read"
  | "head-changed"
  | "notauthed-repo"
  | "enterprise-repo"
  | "notauthed-api"
  | "bad-credentials"
  | "pr-closed"
  | "line-not-in-diff"
  | "unparseable"
  | "bad-success-id"
  | "bad-success-url"
  | "bad-success-credentials"
  | "bad-success-port"
  | "bad-success-query"
  | "bad-success-state"
  | "bad-success-commit"
  /** Exits instantly WITHOUT reading stdin — the EPIPE crasher (see below). */
  | "exit-without-reading-stdin";

function setMode(mode: Mode) {
  process.env.DP_GH_FAKE_MODE = mode;
}

/** Every call the fake saw this test, oldest first. */
function calls(): { args: string[]; stdin: string }[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function reviewPostCalls(): { args: string[]; stdin: string }[] {
  return calls().filter((c) => c.args.includes("POST"));
}

const FAKE_GH = `#!/usr/bin/env node
// Fake \`gh\` for Q6's post_pr_review suite. Records the call, then replies with
// a real GitHub/gh response shape chosen by DP_GH_FAKE_MODE.
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.DP_GH_FAKE_MODE || "ok";

// The EPIPE case: die before touching stdin, exactly as a real gh does when it
// rejects the request (bad auth, 422) or when our timeout SIGKILLs it. Must be
// the FIRST thing, before any stdin read.
if (mode === "exit-without-reading-stdin") {
  fs.appendFileSync(process.env.DP_GH_FAKE_LOG, JSON.stringify({ args, stdin: "" }) + "\\n");
  process.stderr.write("gh: Unprocessable Entity (HTTP 422)\\n");
  process.exit(1);
}

let stdin = "";
try { stdin = fs.readFileSync(0, "utf-8"); } catch { /* no stdin */ }
fs.appendFileSync(process.env.DP_GH_FAKE_LOG, JSON.stringify({ args, stdin }) + "\\n");

const isRepoView = args[0] === "repo" && args[1] === "view";
const isApi = args[0] === "api";

// gh's real wording when no host is authenticated.
const NOT_LOGGED_IN = "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\\nerror: not logged into any GitHub hosts. Run gh auth login to authenticate.\\n";

if (isRepoView) {
  if (mode === "notauthed-repo") { process.stderr.write(NOT_LOGGED_IN); process.exit(1); }
  process.stdout.write(JSON.stringify({ nameWithOwner: "acme/widgets", url: mode === "enterprise-repo" ? "https://github.corp.example/acme/widgets" : "https://github.com/acme/widgets" }));
  process.exit(0);
}
if (isApi) {
  if (mode === "recovery-read") {
    if (args.includes("POST")) { process.stderr.write("Recovery must never POST"); process.exit(99); }
    const fixture = JSON.parse(fs.readFileSync(process.env.DP_GH_RECOVERY_FIXTURE, "utf8"));
    process.stdout.write(JSON.stringify(String(args[1]).includes("/comments?") ? fixture.comments : fixture.review));
    process.exit(0);
  }
  if (mode === "notauthed-api") { process.stderr.write(NOT_LOGGED_IN); process.exit(1); }
  if (mode === "bad-credentials") {
    // An expired / revoked / under-scoped token: gh is logged in, GitHub says no.
    process.stderr.write('gh: Bad credentials (HTTP 401)\\n{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}\\n');
    process.exit(1);
  }
  if (mode === "pr-closed") {
    // gh surfaces the API's 422 body on stderr and exits 1.
    process.stderr.write('gh: Unprocessable Entity (HTTP 422)\\n{"message":"Pull request is closed.","documentation_url":"https://docs.github.com/rest/pulls/reviews"}\\n');
    process.exit(1);
  }
  if (mode === "line-not-in-diff") {
    process.stderr.write('gh: Unprocessable Entity (HTTP 422)\\n{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment","field":"line","code":"invalid","message":"line must be part of the diff"}]}\\n');
    process.exit(1);
  }
  if (mode === "unparseable") { process.stdout.write("<html>502 Bad Gateway</html>"); process.exit(0); }
  if (!args.includes("POST")) {
    process.stdout.write(mode === "head-changed"
      ? "89abcdef0123456789abcdef0123456789abcdef\\n"
      : "0123456789abcdef0123456789abcdef01234567\\n");
    process.exit(0);
  }
  // Success: the documented POST .../reviews response, echoing the event we got.
  const body = JSON.parse(stdin || "{}");
  const state = body.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED"
    : body.event === "APPROVE" ? "APPROVED" : "COMMENTED";
  const target = String(args[1] || "").split("/");
  const htmlUrl = target.length === 6
    ? "https://github.com/" + target[1] + "/" + target[2] + "/pull/" + target[4] + "#pullrequestreview-4242"
    : "https://github.com/acme/widgets/pull/42#pullrequestreview-4242";
  const responseUrl = mode === "bad-success-url"
    ? "https://github.com/attacker/wrong/pull/1"
    : mode === "bad-success-credentials"
      ? htmlUrl.replace("https://", "https://user:secret@")
      : mode === "bad-success-port"
        ? htmlUrl.replace("github.com", "github.com:443")
        : mode === "bad-success-query"
          ? htmlUrl.replace("#", "?transport=proxy#")
          : htmlUrl;
  process.stdout.write(JSON.stringify({
    id: mode === "bad-success-id" ? 0 : 4242,
    state: mode === "bad-success-state" ? "PENDING" : state,
    html_url: responseUrl,
    ...(body.commit_id ? { commit_id: mode === "bad-success-commit" ? "not-a-sha" : body.commit_id } : {}),
    body: body.body,
  }));
  process.exit(0);
}
process.stderr.write("fake gh: unexpected call " + JSON.stringify(args) + "\\n");
process.exit(1);
`;

beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gh-fake-"));
  logPath = path.join(binDir, "calls.log");
  const bin = path.join(binDir, "gh");
  fs.writeFileSync(bin, FAKE_GH);
  fs.chmodSync(bin, 0o755);
  originalPath = process.env.PATH;
  // First on PATH: any real gh on this machine is shadowed for the whole file.
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.DP_GH_FAKE_LOG = logPath;
  // The real 20s network budget would make an ENOENT/hang test glacial.
  process.env.DEEPPAIRING_GH_TIMEOUT_MS = "8000";
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.DP_GH_FAKE_LOG;
  delete process.env.DP_GH_FAKE_MODE;
  delete process.env.DEEPPAIRING_GH_TIMEOUT_MS;
  delete process.env.DP_GH_RECOVERY_FIXTURE;
  fs.rmSync(binDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(logPath, "");
  setMode("ok");
});

// --- fixtures ----------------------------------------------------------------

function researchArtifact(findings: unknown[], status = "approved"): Artifact {
  return {
    id: "art_r1",
    sessionId: "s_review",
    type: "research",
    version: 1,
    parentId: null,
    title: "Review of PR #42",
    status: status as Artifact["status"],
    content: { summary: "what stood out", findings },
    agentReasoning: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  } as Artifact;
}

const HIGH_FINDING = {
  category: "Concurrency",
  title: "Refresh races the write",
  detail: "Two requests can both pass the TTL check.",
  severity: "high",
  significance: "high",
  impact: "Duplicate session rows under load.",
  recommendation: "Take the row lock before the TTL read.",
  evidence: [
    { filePath: "auth/session.ts", lineStart: 26, lineEnd: 31, snippet: "if (ttl < now)", explanation: "check and write are not atomic" },
  ],
};

const LOW_FINDING = {
  category: "Style",
  detail: "Shadowed variable name.",
  severity: "low",
  significance: "low",
  evidence: [{ filePath: "auth/middleware.ts", lineStart: 8, lineEnd: 8, snippet: "const s = ...", explanation: "shadows the import" }],
};

/** Q6 B1(c) — the human's approval of the PR on the review surface, which is
 *  what authorizes a bare APPROVE. */
function approvedExternalChangeset(): Artifact {
  return {
    id: "art_cs", sessionId: "s_review", type: "changeset", version: 1, parentId: null,
    title: "PR #42 — rate limiting", status: "approved",
    content: {
      files: [{ path: "auth/session.ts", changeType: "modified", hunks: [] }],
      reviewIntent: "external", source: {
        kind: "github-pr", number: 42, url: "https://github.com/acme/widgets/pull/42",
        headSha: "0123456789abcdef0123456789abcdef01234567",
      },
    },
    agentReasoning: null, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
  } as Artifact;
}

function sessionState(artifacts: Artifact[]) {
  return { sessionId: "s_review", artifacts, comments: [], decisions: [], planReviews: [] };
}

function payloadFor(findings: unknown[], event?: GitHubReviewPayload["event"]): GitHubReviewPayload {
  return buildGitHubReviewPayload(
    sessionState([researchArtifact(findings)]) as never,
    event ? { event } : {},
  );
}

/** A fake, not a mock: fresh authorization snapshots plus the real durable
 * journal boundary used by handlePostPrReview. */
function fakeCtx(artifacts: Artifact[]) {
  const postedReviews: unknown[] = [];
  const project = fs.mkdtempSync(path.join(binDir, "session-"));
  fs.mkdirSync(path.join(project, ".deeppairing", "sessions", "s_review"), { recursive: true });
  return {
    store: {
      reviewPosts: new ReviewPostJournal(project, "s_review"),
      getReviewPostState: async () => ({
        ...sessionState(artifacts),
        // R1 (#279) — the posted-review record rides full state; the fake keeps
        // what it was given, like FileStore's sidecar.
        ...(postedReviews.length ? { postedReviews } : {}),
      }),
      recordPostedReview: async (r: unknown) => { postedReviews.push(r); },
    },
  } as never;
}

// --- the wire ----------------------------------------------------------------

describe("Q6 — postPrReview against a real (fake) gh process", () => {
  it("posts to the reviews endpoint with the payload on STDIN, not argv", async () => {
    const payload = payloadFor([HIGH_FINDING], "REQUEST_CHANGES");
    const res = await postPrReview({ ref: "https://github.com/acme/widgets/pull/42", payload });

    expect(res).toEqual({
      htmlUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-4242",
      state: "CHANGES_REQUESTED",
      id: 4242,
    });

    const [call, ...rest] = calls();
    // A URL ref carries owner/repo, so repo detection must be SKIPPED — one
    // call, not two (a wasted `gh repo view` would also fail outside a checkout).
    expect(rest).toHaveLength(0);
    expect(call!.args).toEqual([
      "api",
      "repos/acme/widgets/pulls/42/reviews",
      "--hostname", "github.com",
      "-X", "POST",
      "--input", "-",
      "-H", "Accept: application/vnd.github+json",
    ]);
    // The body travels on stdin (`--input -`) — never as an argv blob, which
    // would blow ARG_MAX on a review with many comments and leak the body into
    // the process table.
    const sent = JSON.parse(call!.stdin);
    expect(sent.event).toBe("REQUEST_CHANGES");
    expect(sent.comments).toHaveLength(1);
    expect(sent.body).toContain("deepPairing notes");
  });

  it("detects owner/repo via `gh repo view` when the ref is a bare number", async () => {
    await postPrReview({ ref: "77", payload: payloadFor([LOW_FINDING]) });
    const log = calls();
    expect(log).toHaveLength(2);
    expect(log[0]!.args).toEqual(["repo", "view", "--json", "nameWithOwner,url"]);
    expect(log[1]!.args[1]).toBe("repos/acme/widgets/pulls/77/reviews");
  });

  it("an explicit owner/repo override wins over detection (no repo view at all)", async () => {
    await postPrReview({ ref: "#9", payload: payloadFor([LOW_FINDING]), owner: "other", repo: "fork" });
    const log = calls();
    expect(log).toHaveLength(1);
    expect(log[0]!.args[1]).toBe("repos/other/fork/pulls/9/reviews");
  });

  it("does not translate an enterprise repository into a public github.com target", async () => {
    setMode("enterprise-repo");
    await expect(postPrReview({ ref: "42", payload: payloadFor([LOW_FINDING]) })).rejects.toThrow(/github.com repository/);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.args[0]).toBe("repo");
  });

  it("retains a partial owner override while detecting only the missing repository", async () => {
    await postPrReview({ ref: "42", owner: "other", payload: payloadFor([LOW_FINDING]) });
    expect(calls()[1]!.args[1]).toBe("repos/other/widgets/pulls/42/reviews");
  });

  it("pins a full public PR URL to github.com even with an ambient GH_HOST", async () => {
    const previous = process.env.GH_HOST;
    process.env.GH_HOST = "github.corp.example";
    try {
      await postPrReview({ ref: "https://github.com/acme/widgets/pull/42", payload: payloadFor([LOW_FINDING]) });
      const args = calls()[0]!.args;
      expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
    } finally {
      if (previous === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = previous;
    }
  });
});

describe("Q6 — inline comment anchoring survives the round trip", () => {
  it("each evidence location becomes one path+line+side comment GitHub will accept", async () => {
    const payload = payloadFor([HIGH_FINDING, LOW_FINDING]);
    await postPrReview({ ref: "https://github.com/acme/widgets/pull/42", payload });
    const sent = JSON.parse(calls()[0]!.stdin);

    expect(sent.comments).toEqual([
      expect.objectContaining({ path: "auth/session.ts", line: 31, side: "RIGHT" }),
      expect.objectContaining({ path: "auth/middleware.ts", line: 8, side: "RIGHT" }),
    ]);
    // GitHub's single-line comment shape is exactly {path, line, side, body} —
    // an extra key (e.g. a stray `position` or `start_line`) is a 422. Pin the
    // key set so a future field addition can't silently break every post.
    for (const c of sent.comments) {
      expect(Object.keys(c).sort()).toEqual(["body", "line", "path", "side"]);
      expect(Number.isInteger(c.line)).toBe(true);
      expect(c.line).toBeGreaterThan(0);
      expect(c.path.startsWith("/")).toBe(false); // repo-relative, as the API requires
    }
    // lineEnd anchors a multi-line finding (GitHub anchors a single-line comment
    // at the END of the range) — 26..31 lands on 31.
    expect(sent.comments[0].line).toBe(31);
  });

  it("the severity chip and the recommendation reach the comment body", async () => {
    await postPrReview({ ref: "https://github.com/acme/widgets/pull/42", payload: payloadFor([HIGH_FINDING]) });
    const body = JSON.parse(calls()[0]!.stdin).comments[0].body;
    expect(body).toContain("🟠");
    expect(body).toContain("HIGH");
    expect(body).toContain("Refresh races the write");
    expect(body).toContain("**Recommendation:** Take the row lock before the TTL read.");
  });
});

describe("Q6 — error paths (each one executed, not assumed)", () => {
  it("gh absent → GhMissingError with the install instruction", async () => {
    const saved = process.env.PATH;
    process.env.PATH = path.join(binDir, "definitely-not-here"); // no gh anywhere
    try {
      await expect(
        postPrReview({ ref: "https://github.com/acme/widgets/pull/42", payload: payloadFor([LOW_FINDING]) }),
      ).rejects.toBeInstanceOf(GhMissingError);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("not authenticated on the API call → GhNotAuthedError", async () => {
    setMode("notauthed-api");
    await expect(
      postPrReview({ ref: "https://github.com/acme/widgets/pull/42", payload: payloadFor([LOW_FINDING]) }),
    ).rejects.toBeInstanceOf(GhNotAuthedError);
  });

  it("not authenticated during repo DETECTION → GhNotAuthedError too (the bare-number path)", async () => {
    setMode("notauthed-repo");
    await expect(
      postPrReview({ ref: "12", payload: payloadFor([LOW_FINDING]) }),
    ).rejects.toBeInstanceOf(GhNotAuthedError);
  });

  it("a closed PR surfaces GitHub's own 422 message, not a generic failure", async () => {
    setMode("pr-closed");
    await expect(
      postPrReview({ ref: "https://github.com/acme/widgets/pull/42", payload: payloadFor([LOW_FINDING]) }),
    ).rejects.toThrow(/Pull request is closed/);
  });

  it("an unparseable success body throws the POSTED-BUT-UNPARSEABLE error (never a silent success)", async () => {
    setMode("unparseable");
    await expect(
      postPrReview({ ref: "https://github.com/acme/widgets/pull/42", payload: payloadFor([LOW_FINDING]) }),
    ).rejects.toThrow(/Posted, but could not parse/);
  });

  it("a gh that exits WITHOUT draining stdin fails cleanly — no uncaught EPIPE", async () => {
    // THE BUG Q6 FOUND. A review payload is far past the ~64KB pipe buffer, so
    // the stdin write completes asynchronously; a gh that has already exited
    // (unauthenticated, 422, or SIGKILLed by our own timeout) makes the kernel
    // answer that write with EPIPE. With no 'error' listener on child.stdin
    // that is an UNCAUGHT EXCEPTION — and this runs inside a long-lived stdio
    // MCP server, so the real-world symptom was the whole server dying and the
    // agent losing its connection, not a failed post.
    //
    // INSTRUMENT VERIFIED: with the `child.stdin.on("error", …)` handler in
    // post-review.ts removed, this file reports `Unhandled Errors — write
    // EPIPE` and vitest exits 1, so CI catches a regression even though the
    // assertion below still passes (the rejection is real either way; the crash
    // is the separate, worse half).
    setMode("exit-without-reading-stdin");
    const big = "x".repeat(400_000); // comfortably past the pipe buffer
    const payload: GitHubReviewPayload = {
      body: big,
      event: "COMMENT",
      comments: [{ path: "auth/session.ts", line: 1, side: "RIGHT", body: big }],
    };
    // The failure must arrive as a normal rejection carrying gh's own message.
    await expect(
      postPrReview({ ref: "https://github.com/acme/widgets/pull/42", payload }),
    ).rejects.toThrow(/Unprocessable Entity/);
    // Give any straggling async write a turn to blow up before the test ends.
    await new Promise((r) => setTimeout(r, 50));
  });

  it("an expired/under-scoped token (401 Bad credentials) maps to GhNotAuthedError, not a raw HTTP error", async () => {
    // gh IS logged in; the token is dead. Same one-line fix for the human, so
    // it must reach the same actionable message.
    setMode("bad-credentials");
    await expect(
      postPrReview({ ref: "https://github.com/acme/widgets/pull/42", payload: payloadFor([LOW_FINDING]) }),
    ).rejects.toBeInstanceOf(GhNotAuthedError);
  });

  it("an unparseable PR ref never reaches gh at all", async () => {
    await expect(
      postPrReview({ ref: "the auth one", payload: payloadFor([LOW_FINDING]) }),
    ).rejects.toThrow(/Could not parse PR reference/);
    expect(calls()).toHaveLength(0);
  });
});

// --- the handler -------------------------------------------------------------

describe("Q6 — handlePostPrReview (the MCP tool) end to end", () => {
  it("#344 separate CLI processes preserve uncertain sends and refuse --repost", async () => {
    const project = fs.mkdtempSync(path.join(binDir, "cli-project-"));
    const sessionDir = path.join(project, ".deeppairing", "sessions", "s_review");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "artifacts.json"), JSON.stringify([researchArtifact([HIGH_FINDING])]));
    const originalArtifacts = fs.readFileSync(path.join(sessionDir, "artifacts.json"), "utf8");
    const cli = fileURLToPath(new URL("../../cli/init.ts", import.meta.url));
    const runCli = (mode: Mode, extra: string[] = []) => new Promise<{ code: number; output: string }>((resolve) => {
      execFile(process.execPath, ["--import", import.meta.resolve("tsx"), cli,
        "post-pr-review", "https://github.com/acme/widgets/pull/42", "--session-id", "s_review", ...extra], {
        cwd: project, timeout: 20_000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project, DEEPPAIRING_PROJECT_ROOT: project,
          DP_GH_FAKE_MODE: mode },
      }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, output: stdout + stderr }));
    });

    const first = await runCli("bad-success-state");
    expect(first.code, first.output).toBe(1);
    expect(first.output).toContain("may have reached GitHub");
    expect(new ReviewPostJournal(project, "s_review").list()[0].state).toBe("unknown");
    const second = await runCli("ok", ["--repost"]);
    expect(second.code, second.output).toBe(1);
    expect(second.output).toContain("unknown");
    expect(reviewPostCalls()).toHaveLength(1);
    // Read-only CLI authorization must not flush a stale FileStore snapshot.
    expect(fs.readFileSync(path.join(sessionDir, "artifacts.json"), "utf8")).toBe(originalArtifacts);
  }, 45_000);

  it("#344 explicit remote reconciliation verifies the marked review using GETs only", async () => {
    const ctx = fakeCtx([researchArtifact([HIGH_FINDING])]);
    setMode("bad-success-state");
    await handlePostPrReview(ctx, { pr: "42" });
    const journal = (ctx as any).store.reviewPosts as ReviewPostJournal;
    const operation = journal.list()[0]!;
    expect(operation.state).toBe("unknown");
    const sent = JSON.parse(reviewPostCalls()[0]!.stdin);
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const fixture = {
      review: { id: 4242, html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-4242",
        state: "COMMENTED", body: sent.body, commit_id: commit, submitted_at: new Date().toISOString() },
      comments: sent.comments.map((comment: any, index: number) => ({ ...comment,
        id: index + 1, pull_request_review_id: 4242, original_line: comment.line, original_commit_id: commit })),
    };
    const fixturePath = path.join(binDir, "recovery.json");
    fs.writeFileSync(fixturePath, JSON.stringify(fixture));
    process.env.DP_GH_RECOVERY_FIXTURE = fixturePath;
    setMode("recovery-read");
    const project = path.resolve(path.dirname(journal.journalPath), "..", "..", "..");
    const text = await reconcileReviewPostCommand(project, ["s_review", "reconcile", operation.id, "4242"]);
    expect(text).toContain("No review was posted by recovery");
    expect(journal.list()[0].state).toBe("succeeded");
    expect(reviewPostCalls()).toHaveLength(1);
    expect(calls().slice(-2).every(call => call.args.includes("GET"))).toBe(true);
  });

  it("#344 concurrent MCP posts share one durable send reservation", async () => {
    const ctx = fakeCtx([researchArtifact([HIGH_FINDING])]);
    const results = await Promise.all([0, 1].map(() => handlePostPrReview(ctx, { pr: "42" })));
    expect(results.filter(result => !result.isError)).toHaveLength(1);
    expect(reviewPostCalls()).toHaveLength(1);
  });

  it("#344 an unconfirmed remote response blocks another actual POST even with repost", async () => {
    const ctx = fakeCtx([researchArtifact([HIGH_FINDING])]);
    setMode("bad-success-state");
    const first = await handlePostPrReview(ctx, { pr: "42" });
    expect(first.isError).toBe(true);
    expect(first.content[0]!.text).toContain("may have reached GitHub");
    setMode("ok");
    const again = await handlePostPrReview(ctx, { pr: "42", repost: true });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain("unknown");
    expect(reviewPostCalls()).toHaveLength(1);
  });

  it("posts and reports the review URL", async () => {
    const res = await handlePostPrReview(fakeCtx([researchArtifact([HIGH_FINDING])]), {
      pr: "https://github.com/acme/widgets/pull/42",
      event: "REQUEST_CHANGES",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("Posted 1 inline comment on PR");
    expect(res.content[0]!.text).toContain("as REQUEST_CHANGES");
    expect(res.content[0]!.text).toContain("#pullrequestreview-4242");
    expect(JSON.parse(reviewPostCalls()[0]!.stdin).event).toBe("REQUEST_CHANGES");
  });

  it("event mapping: absent and case-variant events resolve; an UNKNOWN one is refused", async () => {
    // R1 (#279) — this test used to assert that "LGTM" fell back to COMMENT.
    // Falling back is the wrong shape for a write into someone else's
    // repository: the agent asked for something this product does not send, and
    // quietly posting a different review instead is a post nobody requested.
    // Absent still means COMMENT (the documented default at both doors), and a
    // case variant resolves to the event it names — which is the half of this
    // that was a real bug, since lowercase "approve" used to slip past the
    // APPROVE authorization entirely.
    for (const [given, expected] of [[undefined, "COMMENT"], ["comment", "COMMENT"], ["COMMENT", "COMMENT"]] as const) {
      fs.writeFileSync(logPath, "");
      const res = await handlePostPrReview(fakeCtx([researchArtifact([LOW_FINDING])]), {
        pr: "https://github.com/acme/widgets/pull/42",
        ...(given === undefined ? {} : { event: given }),
      });
      expect(res.isError, `event=${given}`).toBeFalsy();
      expect(JSON.parse(reviewPostCalls()[0]!.stdin).event, `event=${given}`).toBe(expected);
    }

    // APPROVE needs the human's approval of the PR itself, so it is exercised
    // with the changeset that authorizes it (and posts with no comments).
    fs.writeFileSync(logPath, "");
    const approve = await handlePostPrReview(fakeCtx([approvedExternalChangeset()]), {
      pr: "https://github.com/acme/widgets/pull/42", event: "approve",
    });
    expect(approve.isError).toBeFalsy();
    expect(JSON.parse(reviewPostCalls()[0]!.stdin).event).toBe("APPROVE");

    fs.writeFileSync(logPath, "");
    const unknown = await handlePostPrReview(fakeCtx([researchArtifact([LOW_FINDING])]), {
      pr: "https://github.com/acme/widgets/pull/42", event: "LGTM",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain("is not a review event");
    expect(calls()).toHaveLength(0);
  });

  it("a missing `pr` argument is refused before any process is spawned", async () => {
    const res = await handlePostPrReview(fakeCtx([researchArtifact([HIGH_FINDING])]), {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("requires a `pr` argument");
    expect(calls()).toHaveLength(0);
  });

  it("nothing to post (no structured evidence) → an explanatory error, no gh call", async () => {
    const res = await handlePostPrReview(
      fakeCtx([researchArtifact([{ category: "Note", detail: "a thought", significance: "low", evidence: "see the README" }])]),
      { pr: "42" },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("No approved findings with structured evidence");
    expect(calls()).toHaveLength(0);
  });

  it("a bare APPROVE with no findings POSTS — once the human approved the PR changeset", async () => {
    // The commonest real outcome of being pinged on a PR. The old guard refused
    // every zero-comment post and told the reviewer to go write findings first.
    // Q6 B1(c): it is allowed now, but only on the human's recorded approval of
    // the external changeset — see review-authorization.test.ts for that gate's
    // own branches.
    const res = await handlePostPrReview(fakeCtx([approvedExternalChangeset()]), { pr: "42", event: "APPROVE" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("no inline comments");
    expect(res.content[0]!.text).not.toContain("Posted 0 inline comments");
    const sent = JSON.parse(calls().at(-1)!.stdin);
    expect(sent.event).toBe("APPROVE");
    expect(sent.commit_id).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(sent.comments).toEqual([]);
    expect(sent.body).toContain("deepPairing notes"); // still says where it came from
  });

  it("#343 prepared send returns GitHub's validated immutable commit binding", async () => {
    const reviewed = "0123456789ABCDEF0123456789ABCDEF01234567";
    const payload = bindReviewPayloadToPreparedTarget(
      { ...payloadFor([HIGH_FINDING], "REQUEST_CHANGES"), commit_id: reviewed },
      reviewed,
      {
        target: "https://github.com/acme/widgets/pull/42",
        currentHeadSha: reviewed,
      },
    );
    const result = await postPreparedPrReview({
      target: "https://github.com/acme/widgets/pull/42",
      payload,
    });

    expect(result.commitId).toBe(reviewed.toLowerCase());
    expect(JSON.parse(reviewPostCalls()[0]!.stdin).commit_id).toBe(reviewed.toLowerCase());
  });

  it("#343 rejects malformed success identity instead of stamping uncertain metadata", async () => {
    const target = "https://github.com/acme/widgets/pull/42";
    for (const mode of [
      "bad-success-id",
      "bad-success-url",
      "bad-success-credentials",
      "bad-success-port",
      "bad-success-query",
      "bad-success-state",
      "bad-success-commit",
    ] as const) {
      fs.writeFileSync(logPath, "");
      setMode(mode);
      await expect(postPreparedPrReview({
        target,
        payload: { ...payloadFor([LOW_FINDING]), commit_id: "0123456789abcdef0123456789abcdef01234567" },
      })).rejects.toThrow(/Posted, but could not parse/);
    }
  });

  it("#343 documents the unavoidable push-after-read race as bound-commit semantics", () => {
    const reviewed = "0123456789abcdef0123456789abcdef01234567";
    // A push can occur after this prepared snapshot and before the POST. There
    // is no GitHub compare-and-post transaction to close that window. The
    // safety property is that we still send the reviewed SHA as commit_id;
    // the later branch head is never substituted into an old verdict.
    const payload = bindReviewPayloadToPreparedTarget(
      payloadFor([LOW_FINDING]),
      reviewed,
      { target: "https://github.com/acme/widgets/pull/42", currentHeadSha: reviewed },
    );
    expect(payload.commit_id).toBe(reviewed);
  });

  it("#343 refuses when the PR head changed after the reviewed artifact was approved", async () => {
    setMode("head-changed");
    const res = await handlePostPrReview(fakeCtx([approvedExternalChangeset()]), { pr: "42", event: "APPROVE" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("changed since your pair reviewed it");
    expect(res.content[0]!.text).toContain("0123456");
    expect(res.content[0]!.text).toContain("89abcde");
    expect(reviewPostCalls()).toHaveLength(0);
  });

  it("#343 rebuilds authorization from fresh local state after the remote head read", async () => {
    let reads = 0;
    const approved = approvedExternalChangeset();
    const withdrawn = { ...approved, status: "revised" as const };
    const ctx = {
      store: {
        getReviewPostState: async () => sessionState(reads++ === 0 ? [approved] : [withdrawn]),
        recordPostedReview: async () => {},
      },
    } as never;

    const res = await handlePostPrReview(ctx, { pr: "42", event: "APPROVE" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("sent back for changes");
    expect(reads).toBe(2);
    expect(calls().some((c) => c.args[0] === "api" && !c.args.includes("POST"))).toBe(true);
    expect(reviewPostCalls()).toHaveLength(0);
  });

  it("refuses a real FileStore's external revocation after the initial MCP gate", async () => {
    const fx = withGlobalStore("dp-mcp-fresh-post-");
    try {
      const stale = fx.track(new FileStore(fx.dir, "s_review"));
      const approved = approvedExternalChangeset();
      stale.createArtifact({ id: approved.id, type: approved.type, title: approved.title, content: approved.content });
      stale.updateArtifactStatus(approved.id, "approved", "ui_approve_button");
      stale.forceFlush();
      const external = fx.track(new FileStore(fx.dir, "s_review"));
      let reads = 0;
      const ctx = { store: {
        reviewPosts: stale.reviewPosts,
        getReviewPostState: async () => {
          const state = stale.getReviewPostState();
          if (++reads === 1) {
            external.updateArtifactStatus(approved.id, "obsolete", "agent_obsolete");
            external.forceFlush();
          }
          return state;
        },
        recordPostedReview: () => { throw new Error("Must not post"); },
      } } as never;
      const res = await handlePostPrReview(ctx, { pr: "42", event: "APPROVE" });
      expect(res.isError).toBe(true);
      expect(reads).toBe(2);
      expect(stale.getFullState().artifacts[0]!.status).toBe("approved");
      expect(reviewPostCalls()).toHaveLength(0);
      expect(stale.reviewPosts.list()).toEqual([]);
    } finally {
      fx.dispose();
    }
  });

  it("…but a zero-comment REQUEST_CHANGES is still refused — blocking someone without saying why", async () => {
    const res = await handlePostPrReview(fakeCtx([]), { pr: "42", event: "REQUEST_CHANGES" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("REQUEST_CHANGES owes the author");
    expect(calls()).toHaveLength(0);
  });

  it("…and a zero-comment COMMENT is refused, pointing at APPROVE as the way out", async () => {
    const res = await handlePostPrReview(fakeCtx([]), { pr: "42" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('event: "APPROVE"');
    expect(calls()).toHaveLength(0);
  });

  it("REJECTED findings never reach the PR — the triage verdict is load-bearing", async () => {
    const rejected = researchArtifact([HIGH_FINDING], "rejected");
    const kept = { ...researchArtifact([LOW_FINDING]), id: "art_r2" } as Artifact;
    const res = await handlePostPrReview(fakeCtx([rejected, kept]), { pr: "42" });
    expect(res.isError).toBeFalsy();
    const sent = JSON.parse(calls().at(-1)!.stdin);
    expect(sent.comments).toHaveLength(1);
    expect(sent.comments[0].path).toBe("auth/middleware.ts");
    expect(JSON.stringify(sent)).not.toContain("Refresh races the write");
  });

  it("gh missing surfaces the INSTALL instruction verbatim, as a tool error", async () => {
    const saved = process.env.PATH;
    process.env.PATH = path.join(binDir, "nope");
    try {
      const res = await handlePostPrReview(fakeCtx([researchArtifact([HIGH_FINDING])]), { pr: "42" });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("cli.github.com");
      expect(res.content[0]!.text).toContain("gh auth login");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("not authenticated surfaces `gh auth login`, as a tool error", async () => {
    setMode("notauthed-api");
    const res = await handlePostPrReview(fakeCtx([researchArtifact([HIGH_FINDING])]), { pr: "42" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("gh auth login");
  });

  it("a 422 from GitHub is relayed with GitHub's own words, prefixed so the agent knows the source", async () => {
    setMode("line-not-in-diff");
    const res = await handlePostPrReview(fakeCtx([researchArtifact([HIGH_FINDING])]), { pr: "42" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("post_pr_review failed");
    // The actionable half: WHICH constraint GitHub rejected. An evidence line
    // outside the PR's diff is the single most likely real-world 422 here, and
    // the agent can only recover (re-anchor the finding) if it is told.
    expect(res.content[0]!.text).toContain("line must be part of the diff");
  });
});
