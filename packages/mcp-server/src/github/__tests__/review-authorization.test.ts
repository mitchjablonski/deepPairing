/**
 * Q6 (#232) B1 — the authorization gate, branch by branch.
 *
 * The adversarial review's finding: `post_pr_review` could post findings the
 * human had never seen, and a bare APPROVE could publish a real approving
 * review on a colleague's PR — with nothing gating either except a sentence in
 * review-pr.md. That sentence was PROVED inadequate by mutation: delete it,
 * hoist the post step above the discussion phase, and the guidance tests still
 * passed 14/14.
 *
 * So the gate is code now, and these are its branches. The last describe block
 * is the mutation proof: it runs the tool against a review-pr.md whose human-
 * gate sentence has been stripped, and shows the post still cannot happen —
 * because the tool never consulted the prose in the first place.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Artifact } from "@deeppairing/shared";
import { authorizeReviewPost } from "../review-authorization.js";
import { handlePostPrReview } from "../../mcp/tools/post-pr-review.js";

// --- the fake gh (same shape as post-review-e2e; success-only) ---------------

let binDir: string;
let logPath: string;
let originalPath: string | undefined;

function calls(): { args: string[]; stdin: string }[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gh-auth-"));
  logPath = path.join(binDir, "calls.log");
  const bin = path.join(binDir, "gh");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf-8"); } catch {}
fs.appendFileSync(process.env.DP_GH_FAKE_LOG, JSON.stringify({ args, stdin }) + "\\n");
if (args[0] === "repo") { process.stdout.write(JSON.stringify({ nameWithOwner: "acme/widgets" })); process.exit(0); }
const body = JSON.parse(stdin || "{}");
process.stdout.write(JSON.stringify({ id: 1, state: body.event === "APPROVE" ? "APPROVED" : "COMMENTED", html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1" }));
process.exit(0);
`);
  fs.chmodSync(bin, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.DP_GH_FAKE_LOG = logPath;
  process.env.DEEPPAIRING_GH_TIMEOUT_MS = "8000";
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  delete process.env.DP_GH_FAKE_LOG;
  delete process.env.DEEPPAIRING_GH_TIMEOUT_MS;
  fs.rmSync(binDir, { recursive: true, force: true });
});

beforeEach(() => fs.writeFileSync(logPath, ""));

// --- fixtures ----------------------------------------------------------------

const EVIDENCE = [{ filePath: "src/limiter.ts", lineStart: 3, lineEnd: 5, snippet: "x", explanation: "y" }];

function findings(id: string, status: string, title = "Review of PR #123", findingTitle = "Refresh races the write"): Artifact {
  return {
    id, sessionId: "s1", type: "research", version: 1, parentId: null, title,
    status: status as Artifact["status"],
    content: {
      summary: "s",
      findings: [{ category: "Concurrency", title: findingTitle, detail: "d", severity: "high", significance: "high", evidence: EVIDENCE }],
    },
    agentReasoning: null, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
  } as Artifact;
}

/** A findings artifact whose evidence is PROSE — nothing to anchor, so it can
 *  never post and its status must not be able to block anything. */
function proseFindings(id: string, status: string): Artifact {
  return {
    id, sessionId: "s1", type: "research", version: 1, parentId: null, title: "General notes",
    status: status as Artifact["status"],
    content: { summary: "s", findings: [{ category: "Note", detail: "a thought", significance: "low", evidence: "see the README" }] },
    agentReasoning: null, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
  } as Artifact;
}

function changeset(id: string, status: string, external: boolean): Artifact {
  return {
    id, sessionId: "s1", type: "changeset", version: 1, parentId: null, title: "PR #123 — rate limiting",
    status: status as Artifact["status"],
    content: {
      files: [{ path: "src/limiter.ts", changeType: "added", hunks: [] }],
      ...(external ? { reviewIntent: "external", source: { kind: "github-pr", number: 123 } } : {}),
    },
    agentReasoning: null, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
  } as Artifact;
}

const session = (artifacts: Artifact[]) => ({ sessionId: "s1", artifacts, comments: [], decisions: [], planReviews: [] });
const ctxFor = (artifacts: Artifact[]) => ({ store: { getFullState: async () => session(artifacts) } }) as never;

// --- (a) nothing unruled may post -------------------------------------------

describe("Q6 B1(a) — un-reviewed findings cannot reach someone else's PR", () => {
  for (const status of ["draft", "reviewing", "revised"]) {
    it(`REFUSES a "${status}" findings artifact and names it`, () => {
      const auth = authorizeReviewPost(session([findings("art_1", status)]), { event: "COMMENT" });
      expect(auth.ok).toBe(false);
      if (auth.ok) throw new Error("unreachable");
      expect(auth.reason).toContain("has not given a verdict");
      expect(auth.reason).toContain("art_1");
      expect(auth.reason).toContain(status);
    });
  }

  it("posts an APPROVED findings artifact", () => {
    const auth = authorizeReviewPost(session([findings("art_1", "approved")]), { event: "COMMENT" });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.payload.comments).toHaveLength(1);
    expect(auth.payload.comments[0]!.path).toBe("src/limiter.ts");
  });

  it("ONE unruled artifact blocks the whole post, even beside an approved one", () => {
    // Fail closed. Posting the approved half and silently dropping the other is
    // the worse outcome: the human believes their concern reached the PR.
    const auth = authorizeReviewPost(
      session([findings("art_ok", "approved"), findings("art_new", "draft", "Second pass")]),
      { event: "COMMENT" },
    );
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("art_new");
  });

  it("a PROSE-only findings artifact never blocks — it could not have posted anyway", () => {
    const auth = authorizeReviewPost(
      session([findings("art_ok", "approved"), proseFindings("art_prose", "draft")]),
      { event: "COMMENT" },
    );
    expect(auth.ok).toBe(true);
  });
});

// --- (b) the human's "no" is honoured ---------------------------------------

describe("Q6 B1(b) — decided-no artifacts are excluded, not refused", () => {
  for (const status of ["rejected", "superseded", "retracted", "obsolete"]) {
    it(`silently excludes a "${status}" artifact and posts the rest`, () => {
      const auth = authorizeReviewPost(
        session([findings("art_ok", "approved", "Kept", "Kept finding"), findings("art_no", status, "Dropped", "Dropped finding")]),
        { event: "COMMENT" },
      );
      expect(auth.ok).toBe(true);
      if (!auth.ok) throw new Error("unreachable");
      expect(auth.payload.comments).toHaveLength(1);
      expect(JSON.stringify(auth.payload)).toContain("Kept finding");
      expect(JSON.stringify(auth.payload)).not.toContain("Dropped finding");
    });
  }

  it("a REJECTED artifact alone posts nothing, and the error says it was excluded", () => {
    const auth = authorizeReviewPost(session([findings("art_no", "rejected", "Dropped")]), { event: "COMMENT" });
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain('"Dropped" is rejected');
  });

  it("the revise-then-approve path: superseded v1 stays out, approved v2 posts", () => {
    // The documented way to drop ONE finding while keeping the rest — pinned so
    // post-pr.md's instruction and the mechanism cannot drift apart.
    const v1 = findings("art_v1", "superseded", "Review v1", "Withdrawn nit");
    const v2 = findings("art_v2", "approved", "Review v2", "Real concern");
    const auth = authorizeReviewPost(session([v1, v2]), { event: "COMMENT" });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(JSON.stringify(auth.payload)).toContain("Real concern");
    expect(JSON.stringify(auth.payload)).not.toContain("Withdrawn nit");
  });
});

// --- (c) a bare APPROVE needs the human's approval of the PR ----------------

describe("Q6 B1(c) — a bare APPROVE is a real verdict and needs real authorization", () => {
  it("REFUSES when the session has no external changeset at all", () => {
    const auth = authorizeReviewPost(session([]), { event: "APPROVE" });
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("nothing in this session records your pair approving this PR");
    expect(auth.reason).toContain('reviewIntent: "external"');
  });

  for (const status of ["draft", "reviewing", "revised", "rejected"]) {
    it(`REFUSES when the external changeset is "${status}"`, () => {
      const auth = authorizeReviewPost(session([changeset("cs_1", status, true)]), { event: "APPROVE" });
      expect(auth.ok).toBe(false);
      if (auth.ok) throw new Error("unreachable");
      expect(auth.reason).toContain("has not approved the PR changeset");
    });
  }

  it("ALLOWS once the human approved the external changeset", () => {
    const auth = authorizeReviewPost(session([changeset("cs_1", "approved", true)]), { event: "APPROVE" });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.payload.event).toBe("APPROVE");
    expect(auth.payload.comments).toEqual([]);
  });

  it("an approved LOCAL changeset does NOT authorize it — it isn't the PR", () => {
    // The control that keeps (c) meaningful: approving your own work must never
    // be mistaken for approving a colleague's pull request.
    const auth = authorizeReviewPost(session([changeset("cs_local", "approved", false)]), { event: "APPROVE" });
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("nothing in this session records your pair approving this PR");
  });

  it("zero-comment COMMENT and REQUEST_CHANGES are still refused, changeset or not", () => {
    const state = session([changeset("cs_1", "approved", true)]);
    expect(authorizeReviewPost(state, { event: "COMMENT" }).ok).toBe(false);
    expect(authorizeReviewPost(state, { event: "REQUEST_CHANGES" }).ok).toBe(false);
  });
});

// --- both doors --------------------------------------------------------------

describe("Q6 B1 — the gate is enforced before anything leaves the machine", () => {
  it("the MCP tool spawns NO gh process when authorization fails", async () => {
    const res = await handlePostPrReview(ctxFor([findings("art_1", "draft")]), { pr: "42" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("has not given a verdict");
    // The point of the whole exercise: nothing reached the network layer.
    expect(calls()).toHaveLength(0);
  });

  it("the MCP tool posts once authorization succeeds", async () => {
    const res = await handlePostPrReview(ctxFor([findings("art_1", "approved")]), {
      pr: "https://github.com/acme/widgets/pull/42", event: "REQUEST_CHANGES",
    });
    expect(res.isError).toBeFalsy();
    expect(calls()).toHaveLength(1);
    expect(JSON.parse(calls()[0]!.stdin).comments).toHaveLength(1);
  });

  it("a bare APPROVE through the MCP tool spawns no gh without the changeset approval", async () => {
    const res = await handlePostPrReview(ctxFor([changeset("cs_1", "draft", true)]), { pr: "42", event: "APPROVE" });
    expect(res.isError).toBe(true);
    expect(calls()).toHaveLength(0);
  });

  it("the CLI door runs the IDENTICAL gate — one function, two callers", async () => {
    // cli/init.ts's postPrReviewCmd is the second way out of this machine. It
    // imports authorizeReviewPost and builds its payload no other way; a gate on
    // only the MCP tool would leave `deeppairing post-pr-review` wide open.
    const init = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "../../cli/init.ts"), "utf-8",
    );
    expect(init).toContain("authorizeReviewPost");
    // And it must not have kept a private path to the raw payload builder.
    const cmd = init.slice(init.indexOf("async function postPrReviewCmd"), init.indexOf("U0.6 —"));
    expect(cmd).not.toContain("buildGitHubReviewPayload");
    expect(cmd).toContain("auth.ok");
  });

  it("there is NO force/override flag anywhere in the gate or its callers", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const sources = [
      fs.readFileSync(path.join(dir, "../review-authorization.ts"), "utf-8"),
      fs.readFileSync(path.join(dir, "../../mcp/tools/post-pr-review.ts"), "utf-8"),
    ].join("\n");
    expect(sources).not.toMatch(/\bforce\b\s*[:=]/i);
    expect(sources).not.toMatch(/args\?\.\s*force/i);
    expect(sources).not.toMatch(/process\.env\.[A-Z_]*(FORCE|SKIP|BYPASS)/);
  });
});

// --- the mutation proof ------------------------------------------------------

describe("Q6 B1 — MUTATION PROOF: the gate does not depend on the prose", () => {
  it("with review-pr.md's human-gate sentences STRIPPED, the post is still impossible", async () => {
    // The reviewer's exact demonstration, inverted into a test. We mutate the
    // command file the way the review did — remove every sentence telling the
    // agent to wait for the human — and show the tool is unmoved, because it
    // reads the STORE, not the guidance.
    const cmdPath = path.join(
      path.dirname(new URL(import.meta.url).pathname), "../../../../../claude-plugin/commands/review-pr.md",
    );
    const original = fs.readFileSync(cmdPath, "utf-8");
    const mutated = original
      .split("\n")
      .filter((l) => !/post|verdict|approve|explicit/i.test(l))
      .join("\n");
    // Sanity: the mutation really did remove the guidance.
    expect(mutated).not.toMatch(/post the review/i);
    expect(mutated.length).toBeLessThan(original.length);

    fs.writeFileSync(cmdPath, mutated);
    try {
      // Un-reviewed findings: still refused.
      const unruled = await handlePostPrReview(ctxFor([findings("art_1", "draft")]), { pr: "42" });
      expect(unruled.isError).toBe(true);
      expect(calls()).toHaveLength(0);

      // Bare APPROVE with no changeset approval: still refused.
      const approve = await handlePostPrReview(ctxFor([changeset("cs_1", "draft", true)]), { pr: "42", event: "APPROVE" });
      expect(approve.isError).toBe(true);
      expect(calls()).toHaveLength(0);
    } finally {
      fs.writeFileSync(cmdPath, original);
    }
    // And the file is back exactly as it was — this test leaves no trace.
    expect(fs.readFileSync(cmdPath, "utf-8")).toBe(original);
  });
});
