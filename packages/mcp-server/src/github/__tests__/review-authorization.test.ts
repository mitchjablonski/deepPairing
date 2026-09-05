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

const REVIEWED_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";

// --- the fake gh (same shape as post-review-e2e; success-only) ---------------

let binDir: string;
let logPath: string;
let originalPath: string | undefined;

function calls(): { args: string[]; stdin: string }[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** R1 — just the REVIEW POSTs. A bare "42" ref makes postPrReview run
 *  `gh repo view` first to detect the repo, so counting every gh invocation
 *  would count the lookup as a post. This counts what actually lands on the PR. */
function apiCalls(): { args: string[]; stdin: string }[] {
  return calls().filter((c) => c.args[0] === "api" && c.args.includes("POST"));
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
if (args[0] === "repo") { process.stdout.write(JSON.stringify({ nameWithOwner: "acme/widgets", url: "https://github.com/acme/widgets" })); process.exit(0); }
if (args[0] === "api" && !args.includes("POST")) { process.stdout.write("${REVIEWED_SHA}\\n"); process.exit(0); }
const body = JSON.parse(stdin || "{}");
const target = String(args[1] || "").split("/");
const state = body.event === "APPROVE" ? "APPROVED"
  : body.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
process.stdout.write(JSON.stringify({
  id: 1,
  state,
  html_url: "https://github.com/" + target[1] + "/" + target[2] + "/pull/" + target[4] + "#pullrequestreview-1",
  ...(body.commit_id ? { commit_id: body.commit_id } : {}),
}));
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

function changeset(id: string, status: string, external: boolean, headSha: unknown = REVIEWED_SHA): Artifact {
  return {
    id, sessionId: "s1", type: "changeset", version: 1, parentId: null, title: "PR #123 — rate limiting",
    status: status as Artifact["status"],
    content: {
      files: [{ path: "src/limiter.ts", changeType: "added", hunks: [] }],
      ...(external ? {
        reviewIntent: "external",
        source: {
          kind: "github-pr", number: 42, url: "https://github.com/acme/widgets/pull/42",
          ...(headSha !== null ? { headSha } : {}),
        },
      } : {}),
    },
    agentReasoning: null, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
  } as Artifact;
}

/** R1 (#279) — a finding whose audience is INTERNAL: the human's own ledger
 *  stance, shown to them, never to the PR author. */
function internalFindings(id: string, status: string, findingTitle = "Your ledger says the opposite"): Artifact {
  return {
    id, sessionId: "s1", type: "research", version: 1, parentId: null, title: "Ledger sweep",
    status: status as Artifact["status"],
    content: {
      summary: "s",
      findings: [{
        category: "Stance", title: findingTitle, detail: "You rejected this on 2026-03-04: \"too much magic\".",
        severity: "high", significance: "high", audience: "internal", evidence: EVIDENCE,
      }],
    },
    agentReasoning: null, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
  } as Artifact;
}

/** A findings artifact at a chosen severity — for the REQUEST_CHANGES gate. */
function findingsAt(id: string, severity: string, status = "approved"): Artifact {
  return {
    id, sessionId: "s1", type: "research", version: 1, parentId: null, title: "Review",
    status: status as Artifact["status"],
    content: {
      summary: "s",
      findings: [{ category: "Style", title: `A ${severity} note`, detail: "d", severity, significance: "low", evidence: EVIDENCE }],
    },
    agentReasoning: null, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
  } as Artifact;
}

const session = (artifacts: Artifact[], extra: Record<string, unknown> = {}) =>
  ({ sessionId: "s1", artifacts, comments: [], decisions: [], planReviews: [], ...extra });
/** R1 — a FAKE store, not a mock: what recordPostedReview writes is what the
 *  next getFullState hands back, exactly like FileStore's sidecar. That is what
 *  makes "call the tool twice, the second refuses" a real end-to-end pin. */
const ctxFor = (artifacts: Artifact[]) => {
  const postedReviews: unknown[] = [];
  return {
    store: {
      getFullState: async () => session(artifacts, postedReviews.length ? { postedReviews } : {}),
      recordPostedReview: async (r: unknown) => { postedReviews.push(r); },
    },
  } as never;
};

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

  for (const status of ["draft", "reviewing"]) {
    it(`REFUSES when the external changeset is "${status}"`, () => {
      const auth = authorizeReviewPost(session([changeset("cs_1", status, true)]), { event: "APPROVE" });
      expect(auth.ok).toBe(false);
      if (auth.ok) throw new Error("unreachable");
      expect(auth.reason).toContain("has not approved the PR changeset");
    });
  }

  // R1 (#279) — "revised" and "rejected" are no longer just "not approved":
  // they are the OPPOSITE verdict, and the refusal now says which one it is
  // instead of implying the human simply hasn't got round to it.
  for (const [status, phrase] of [["revised", "sent back for changes"], ["rejected", "REJECTED"]] as const) {
    it(`REFUSES a bare APPROVE when the external changeset is "${status}", naming their verdict`, () => {
      const auth = authorizeReviewPost(session([changeset("cs_1", status, true)]), { event: "APPROVE" });
      expect(auth.ok).toBe(false);
      if (auth.ok) throw new Error("unreachable");
      expect(auth.reason).toContain(phrase);
    });
  }

  it("ALLOWS once the human approved the external changeset", () => {
    const auth = authorizeReviewPost(session([changeset("cs_1", "approved", true)]), { event: "APPROVE" });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.payload.event).toBe("APPROVE");
    expect(auth.payload.commit_id).toBe(REVIEWED_SHA);
    expect(auth.reviewedHeadSha).toBe(REVIEWED_SHA);
    expect(auth.payload.comments).toEqual([]);
  });

  it("#343 — REFUSES APPROVE when legacy provenance has no immutable reviewed SHA", () => {
    const auth = authorizeReviewPost(
      session([changeset("cs_legacy", "approved", true, null)]),
      { event: "APPROVE", pr: "https://github.com/acme/widgets/pull/42" },
    );
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("reviewed head SHA");
    expect(auth.reason).toContain("cs_legacy");
  });

  it("#343 — REFUSES APPROVE when a persisted SHA is malformed", () => {
    const auth = authorizeReviewPost(
      session([changeset("cs_bad", "approved", true, "not-a-sha")]),
      { event: "APPROVE", pr: "https://github.com/acme/widgets/pull/42" },
    );
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("malformed");
    expect(auth.reason).toContain("cs_bad");
  });

  // T1 (round-15) — THE BARE-APPROVE BODY. What lands on the colleague's PR must
  // read like a human approval, not the internal empty-state string round 12
  // flagged unfit to send.
  it("a bare APPROVE carries a human-readable approval body, not the empty-state string", () => {
    const auth = authorizeReviewPost(session([changeset("cs_1", "approved", true)]), { event: "APPROVE" });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.payload.body).toContain("Reviewed with deepPairing");
    expect(auth.payload.body).toContain("no blocking findings");
    expect(auth.payload.body).not.toContain("No reviewable findings with structured evidence");
  });

  // R1 non-regression — the reviewer's local folder name (the session id) must
  // never ride the outbound body, bare-APPROVE included.
  it("the bare-APPROVE body never leaks the session id / folder name", () => {
    const leaky = session([changeset("cs_1", "approved", true)], {
      sessionId: "session_my-secret-client-project_ab12cd",
    });
    const auth = authorizeReviewPost(leaky, { event: "APPROVE" });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.payload.body).not.toContain("my-secret-client-project");
    expect(auth.payload.body).not.toContain("Session ");
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

// --- R1 fix 1: the APPROVE hole -------------------------------------------

describe("R1 (#279) fix 1 — an APPROVE WITH comments is still an APPROVE", () => {
  // Round 13's execution: the external-changeset requirement lived inside
  // `if (payload.comments.length === 0)`, so ONE approved finding skipped it
  // entirely. An approving review went out on a PR with both changesets in
  // draft, and again on a PR the human had rejected.
  it("REFUSES approve-with-comments while the external changeset is still DRAFT", () => {
    const auth = authorizeReviewPost(
      session([findings("art_1", "approved"), changeset("cs_1", "draft", true)]),
      { event: "APPROVE" },
    );
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("Refusing to post an APPROVE");
    expect(auth.reason).toContain("cs_1");
  });

  it("REFUSES approve-with-comments when the human REJECTED the PR, and says so", () => {
    const auth = authorizeReviewPost(
      session([findings("art_1", "approved"), changeset("cs_1", "rejected", true)]),
      { event: "APPROVE" },
    );
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("REJECTED");
    expect(auth.reason).toContain("PR #123 — rate limiting");
    expect(auth.reason).toContain("cs_1");
  });

  it("REFUSES approve-with-comments when they sent the PR back for changes", () => {
    const auth = authorizeReviewPost(
      session([findings("art_1", "approved"), changeset("cs_1", "revised", true)]),
      { event: "APPROVE" },
    );
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("sent back for changes");
  });

  it("ALLOWS approve-with-comments once they approved the changeset", () => {
    const auth = authorizeReviewPost(
      session([findings("art_1", "approved"), changeset("cs_1", "approved", true)]),
      { event: "APPROVE" },
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.payload.event).toBe("APPROVE");
    expect(auth.payload.comments).toHaveLength(1);
  });

  it("the MCP door spawns no gh for approve-with-comments on a rejected PR", async () => {
    const res = await handlePostPrReview(
      ctxFor([findings("art_1", "approved"), changeset("cs_1", "rejected", true)]),
      { pr: "42", event: "APPROVE" },
    );
    expect(res.isError).toBe(true);
    expect(calls()).toHaveLength(0);
  });

  it("rechecks the resolved destination so owner/repo overrides cannot borrow an approval", async () => {
    const result = await handlePostPrReview(ctxFor([changeset("cs_1", "approved", true)]), {
      pr: "42", owner: "unreviewed", repo: "other", event: "APPROVE",
    });
    expect(result.isError).toBe(true);
    expect(apiCalls()).toHaveLength(0);
  });
});

// --- R1 fix 2: one-of-N ----------------------------------------------------

describe("R1 (#279) fix 2 — ALL live external changesets must be approved", () => {
  const split = (s1: string, s2: string, s3: string) => [
    changeset("cs_1", s1, true), changeset("cs_2", s2, true), changeset("cs_3", s3, true),
  ];

  it("REFUSES when 1 of 3 chunks is approved, and counts them", () => {
    const auth = authorizeReviewPost(session(split("approved", "draft", "draft")), { event: "APPROVE" });
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("approved 1 of 3 changesets");
  });

  it("REFUSES at 2 of 3 too — 'most of it' is not the whole PR", () => {
    const auth = authorizeReviewPost(session(split("approved", "approved", "reviewing")), { event: "APPROVE" });
    expect(auth.ok).toBe(false);
  });

  it("ALLOWS when all 3 are approved", () => {
    const auth = authorizeReviewPost(session(split("approved", "approved", "approved")), { event: "APPROVE" });
    expect(auth.ok).toBe(true);
  });

  it("a SUPERSEDED chunk doesn't count against them (the live ones do)", () => {
    // Revising a chunk closes v1; only what still stands needs a verdict.
    const auth = authorizeReviewPost(
      session([changeset("cs_v1", "superseded", true), changeset("cs_v2", "approved", true)]),
      { event: "APPROVE" },
    );
    expect(auth.ok).toBe(true);
  });

  it("REFUSES when every external changeset is closed — nothing standing was approved", () => {
    const auth = authorizeReviewPost(session([changeset("cs_v1", "superseded", true)]), { event: "APPROVE" });
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("closed");
  });

  it("#343 — REFUSES chunks from different reviewed commits", () => {
    const auth = authorizeReviewPost(session([
      changeset("cs_a", "approved", true, REVIEWED_SHA),
      changeset("cs_b", "approved", true, OTHER_SHA),
    ]), { event: "APPROVE", pr: "https://github.com/acme/widgets/pull/42" });
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain("different reviewed commits");
    expect(auth.reason).toContain("cs_a");
    expect(auth.reason).toContain("cs_b");
  });

  it("#343 — legacy COMMENT remains readable/postable, but mixed SHA provenance refuses", () => {
    const legacy = authorizeReviewPost(
      session([findings("art_1", "approved"), changeset("cs_legacy", "approved", true, null)]),
      { event: "COMMENT", pr: "https://github.com/acme/widgets/pull/42" },
    );
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error("unreachable");
    expect(legacy.payload.commit_id).toBeUndefined();
    expect(legacy.reviewedHeadSha).toBeUndefined();

    const mixed = authorizeReviewPost(
      session([
        findings("art_1", "approved"),
        changeset("cs_sha", "approved", true, REVIEWED_SHA),
        changeset("cs_legacy", "approved", true, null),
      ]),
      { event: "COMMENT", pr: "https://github.com/acme/widgets/pull/42" },
    );
    expect(mixed.ok).toBe(false);
    if (mixed.ok) throw new Error("unreachable");
    expect(mixed.reason).toContain("mixed immutable-SHA provenance");
  });

  it("#343 — once COMMENT has SHA provenance, every standing chunk must have one valid canonical SHA", () => {
    const malformed = authorizeReviewPost(
      session([
        findings("art_1", "approved"),
        changeset("cs_good", "approved", true, REVIEWED_SHA.toUpperCase()),
        changeset("cs_bad", "approved", true, "abc123"),
      ]),
      { event: "COMMENT", pr: "https://github.com/acme/widgets/pull/42" },
    );
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error("unreachable");
    expect(malformed.reason).toContain("malformed reviewed head SHA");

    const canonical = authorizeReviewPost(
      session([findings("art_1", "approved"), changeset("cs_upper", "approved", true, REVIEWED_SHA.toUpperCase())]),
      { event: "COMMENT", pr: "https://github.com/acme/widgets/pull/42" },
    );
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) throw new Error("unreachable");
    expect(canonical.reviewedHeadSha).toBe(REVIEWED_SHA);
    expect(canonical.payload.commit_id).toBe(REVIEWED_SHA);
  });

  it("#343 — closed legacy/malformed chunks do not contaminate the standing reviewed commit", () => {
    const auth = authorizeReviewPost(session([
      changeset("cs_old", "superseded", true, "not-a-sha"),
      changeset("cs_live", "approved", true, REVIEWED_SHA),
    ]), { event: "APPROVE", pr: "https://github.com/acme/widgets/pull/42" });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.reviewedHeadSha).toBe(REVIEWED_SHA);
  });
});

// --- R1 fix 3: event normalization at BOTH doors ---------------------------

describe("R1 (#279) fix 3 — the event is normalized and whitelisted in ONE place", () => {
  const HOSTILE = ["bogus", "MERGE", "PENDING", "DISMISS", "approve", "Approve", " approve "];

  for (const value of HOSTILE) {
    it(`"${value}" never reaches GitHub as an unchecked event`, () => {
      // Two failure shapes, both correct: a junk event is REFUSED outright, and
      // a case-variant of a real one is UPPERCASED so it gets that event's
      // authorization. What must never happen (the round-13 finding) is
      // "approve" sliding past a `=== "APPROVE"` test into an unauthorized post.
      const auth = authorizeReviewPost(session([changeset("cs_1", "draft", true)]), { event: value });
      expect(auth.ok).toBe(false);
      if (auth.ok) throw new Error("unreachable");
      if (/^\s*approve\s*$/i.test(value)) {
        expect(auth.reason).toContain("Refusing to post an APPROVE");
      } else {
        expect(auth.reason).toContain("is not a review event");
      }
    });
  }

  it("lowercase 'approve' is honoured as APPROVE once authorized", () => {
    const auth = authorizeReviewPost(session([changeset("cs_1", "approved", true)]), { event: "approve" });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.payload.event).toBe("APPROVE");
  });

  it("absent / empty event defaults to COMMENT (both doors' documented default)", () => {
    for (const value of [undefined, "", "   "]) {
      const auth = authorizeReviewPost(session([findings("art_1", "approved")]), { event: value });
      expect(auth.ok).toBe(true);
      if (!auth.ok) throw new Error("unreachable");
      expect(auth.payload.event).toBe("COMMENT");
    }
  });

  it("R1 F2 — a NON-STRING event is refused before it is ever stringified", () => {
    // ["approve"] and { toString: () => "approve" } both String()-coerce to
    // "approve". Accepting whatever a value's coercion spells is not the enum
    // contract; the honest answer is "the event must be a string".
    const hostile: unknown[] = [["approve"], { toString: () => "approve" }, 42, true, { event: "APPROVE" }];
    for (const value of hostile) {
      const auth = authorizeReviewPost(session([changeset("cs_1", "approved", true)]), { event: value });
      expect(auth.ok).toBe(false);
      if (auth.ok) throw new Error("unreachable");
      expect(auth.reason).toContain("must be a string");
    }
  });

  it("the MCP door spawns no gh for a hostile event", async () => {
    for (const value of HOSTILE) {
      const res = await handlePostPrReview(ctxFor([findings("art_1", "approved")]), { pr: "42", event: value });
      expect(res.isError).toBe(true);
    }
    expect(calls()).toHaveLength(0);
  });

  it("the CLI door hands the RAW value to the gate — no local default, no local whitelist", () => {
    const init = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "../../cli/init.ts"), "utf-8",
    );
    const cmd = init.slice(init.indexOf("async function postPrReviewCmd"), init.indexOf("U0.6 —"));
    // The exact pre-R1 line that let "bogus"/"MERGE"/"approve" through.
    expect(cmd).not.toContain('(event as any) || "COMMENT"');
    expect(cmd).toContain("authorizeReviewPost(state, { event, pr: ref, repost })");
  });
});

// --- R1 fix 4: internal findings never leave the machine -------------------

describe("R1 (#279) fix 4 — an internal-audience finding is never posted", () => {
  it("an APPROVED internal finding produces NO comment and appears nowhere in the payload", () => {
    const auth = authorizeReviewPost(
      session([findings("art_ok", "approved"), internalFindings("art_int", "approved")]),
      { event: "COMMENT" },
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.payload.comments).toHaveLength(1);
    const wire = JSON.stringify(auth.payload);
    expect(wire).not.toContain("Your ledger says the opposite");
    expect(wire).not.toContain("too much magic");
  });

  it("an internal-only artifact can't post at all — and can't block either", () => {
    // Same rule as a prose-only artifact: it was never going to post, so its
    // status is not load-bearing. A DRAFT internal artifact must not refuse the
    // whole review.
    const blocked = authorizeReviewPost(
      session([findings("art_ok", "approved"), internalFindings("art_int", "draft")]),
      { event: "COMMENT" },
    );
    expect(blocked.ok).toBe(true);

    const alone = authorizeReviewPost(session([internalFindings("art_int", "approved")]), { event: "COMMENT" });
    expect(alone.ok).toBe(false);
  });

  it("a finding with NO audience field posts exactly as before (back-compat)", () => {
    const auth = authorizeReviewPost(session([findings("art_1", "approved")]), { event: "COMMENT" });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.payload.comments).toHaveLength(1);
  });

  it("nothing internal reaches the gh process end to end", async () => {
    const res = await handlePostPrReview(
      ctxFor([findings("art_ok", "approved"), internalFindings("art_int", "approved")]),
      { pr: "42" },
    );
    expect(res.isError).toBeFalsy();
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0]!.stdin).not.toContain("too much magic");
  });
});

// --- R1 fix 5: no session id, no folder name, in an outbound body ----------

describe("R1 (#279) fix 5 — the posted body carries no session id and no folder name", () => {
  const folderSession = (artifacts: Artifact[]) =>
    ({ sessionId: "session_my-secret-client-project_ab12cd", artifacts, comments: [], decisions: [], planReviews: [] });

  for (const event of ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const) {
    it(`${event}: the body has no "session_" and no folder token`, () => {
      const arts = event === "APPROVE"
        ? [changeset("cs_1", "approved", true)]
        : [findings("art_1", "approved")];
      const auth = authorizeReviewPost(folderSession(arts), { event });
      expect(auth.ok).toBe(true);
      if (!auth.ok) throw new Error("unreachable");
      const wire = JSON.stringify(auth.payload);
      expect(wire).not.toContain("session_");
      expect(wire).not.toContain("my-secret-client-project");
      expect(wire).not.toContain("ab12cd");
    });
  }

  it("still attributes deepPairing (the footer survives, the id doesn't)", () => {
    const auth = authorizeReviewPost(folderSession([findings("art_1", "approved")]), { event: "COMMENT" });
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.payload.body).toContain("deepPairing");
    expect(auth.payload.body).not.toMatch(/Session:/i);
  });
});

// --- R1 fix 6: idempotency -------------------------------------------------

describe("R1 (#279) fix 6 — a review posts ONCE", () => {
  it("five calls post one review; the rest refuse with the URL", async () => {
    const ctx = ctxFor([findings("art_1", "approved")]);
    const first = await handlePostPrReview(ctx, { pr: "42" });
    expect(first.isError).toBeFalsy();
    for (let i = 0; i < 4; i++) {
      const again = await handlePostPrReview(ctx, { pr: "42" });
      expect(again.isError).toBe(true);
      expect(again.content[0]!.text).toContain("already posted");
      expect(again.content[0]!.text).toContain("pullrequestreview-1");
    }
    expect(apiCalls()).toHaveLength(1); // exactly one review actually posted
  });

  it("the same PR by URL and by number is the same PR", async () => {
    const ctx = ctxFor([findings("art_1", "approved")]);
    await handlePostPrReview(ctx, { pr: "https://github.com/acme/widgets/pull/42" });
    const again = await handlePostPrReview(ctx, { pr: "42" });
    expect(again.isError).toBe(true);
    expect(apiCalls()).toHaveLength(1);
  });

  it("a DIFFERENT PR from the same session still posts", async () => {
    const ctx = ctxFor([findings("art_1", "approved")]);
    await handlePostPrReview(ctx, { pr: "42" });
    const other = await handlePostPrReview(ctx, { pr: "43" });
    expect(other.isError).toBeFalsy();
    expect(apiCalls()).toHaveLength(2);
  });

  it("repost: true re-arms it — and every verdict check still runs", async () => {
    const ctx = ctxFor([findings("art_1", "approved")]);
    await handlePostPrReview(ctx, { pr: "42" });
    const again = await handlePostPrReview(ctx, { pr: "42", repost: true });
    expect(again.isError).toBeFalsy();
    expect(apiCalls()).toHaveLength(2);

    // The re-post flag is NOT a force flag: unruled findings still refuse.
    const unruled = ctxFor([findings("art_1", "draft")]);
    const blocked = await handlePostPrReview(unruled, { pr: "42", repost: true });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]!.text).toContain("has not given a verdict");
  });
});

// --- R1 fix 7: the severity gate ------------------------------------------

describe("R1 (#279) fix 7 — REQUEST_CHANGES needs a finding that earns it", () => {
  for (const severity of ["info", "low", "medium"]) {
    it(`REFUSES a REQUEST_CHANGES whose highest approved severity is "${severity}"`, () => {
      const auth = authorizeReviewPost(session([findingsAt("art_1", severity)]), { event: "REQUEST_CHANGES" });
      expect(auth.ok).toBe(false);
      if (auth.ok) throw new Error("unreachable");
      expect(auth.reason).toContain(`highest severity your pair approved is "${severity}"`);
      expect(auth.reason).toContain("COMMENT");
    });

    it(`the same findings post fine as a COMMENT ("${severity}")`, () => {
      expect(authorizeReviewPost(session([findingsAt("art_1", severity)]), { event: "COMMENT" }).ok).toBe(true);
    });
  }

  for (const severity of ["high", "critical"]) {
    it(`ALLOWS a REQUEST_CHANGES on a "${severity}" finding`, () => {
      const auth = authorizeReviewPost(session([findingsAt("art_1", severity)]), { event: "REQUEST_CHANGES" });
      expect(auth.ok).toBe(true);
    });
  }

  it("a finding with NO severity reads as info — not as a licence to block", () => {
    const bare = {
      id: "art_1", sessionId: "s1", type: "research", version: 1, parentId: null, title: "T", status: "approved",
      content: { summary: "s", findings: [{ category: "c", detail: "d", significance: "low", evidence: EVIDENCE }] },
      agentReasoning: null, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
    } as unknown as Artifact;
    expect(authorizeReviewPost(session([bare]), { event: "REQUEST_CHANGES" }).ok).toBe(false);
  });

  it("an INTERNAL high finding cannot authorize a REQUEST_CHANGES it can't be part of", () => {
    // The composition trap: internal findings are excluded from the payload, so
    // letting one satisfy the severity gate would post a blocking review whose
    // inline comments are all low-severity nits.
    const auth = authorizeReviewPost(
      session([findingsAt("art_low", "low"), internalFindings("art_int", "approved")]),
      { event: "REQUEST_CHANGES" },
    );
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("unreachable");
    expect(auth.reason).toContain('highest severity your pair approved is "low"');
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
    expect(apiCalls()).toHaveLength(1);
    expect(JSON.parse(apiCalls()[0]!.stdin).comments).toHaveLength(1);
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
    expect(cmd).toContain("const finalReader = new FileStore");
    expect(cmd).toContain("finalReader.dispose()");
    expect(cmd).not.toMatch(/\.forceFlush\s*\(/);
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

      // R1 (#279) — THE SAME PROOF, EXTENDED TO THE NEW BRANCHES. Each of these
      // rules also exists as a sentence in the very file we just gutted; the
      // point is that deleting the sentence changes nothing.
      //
      // 1. APPROVE with comments, external still draft.
      const approveWithComments = await handlePostPrReview(
        ctxFor([findings("art_1", "approved"), changeset("cs_1", "draft", true)]),
        { pr: "42", event: "APPROVE" },
      );
      expect(approveWithComments.isError).toBe(true);

      // 1b. APPROVE on a PR the human REJECTED.
      const approveRejected = await handlePostPrReview(
        ctxFor([findings("art_1", "approved"), changeset("cs_1", "rejected", true)]),
        { pr: "42", event: "APPROVE" },
      );
      expect(approveRejected.isError).toBe(true);

      // 2. One of three chunks approved.
      const oneOfThree = await handlePostPrReview(
        ctxFor([changeset("cs_1", "approved", true), changeset("cs_2", "draft", true), changeset("cs_3", "draft", true)]),
        { pr: "42", event: "APPROVE" },
      );
      expect(oneOfThree.isError).toBe(true);

      // 3. A junk event.
      const junk = await handlePostPrReview(ctxFor([findings("art_1", "approved")]), { pr: "42", event: "MERGE" });
      expect(junk.isError).toBe(true);

      // 7. REQUEST_CHANGES off a low-severity finding.
      const softBlock = await handlePostPrReview(ctxFor([findingsAt("art_1", "low")]), { pr: "42", event: "REQUEST_CHANGES" });
      expect(softBlock.isError).toBe(true);

      // Not one of them reached the network.
      expect(calls()).toHaveLength(0);

      // 4. And the one rule that does not REFUSE but must still hold with the
      // prose gone: an internal finding is excluded from what does post.
      const posted = await handlePostPrReview(
        ctxFor([findings("art_ok", "approved"), internalFindings("art_int", "approved")]),
        { pr: "https://github.com/acme/widgets/pull/42" },
      );
      expect(posted.isError).toBeFalsy();
      expect(apiCalls()).toHaveLength(1);
      expect(apiCalls()[0]!.stdin).not.toContain("too much magic");
      // 5. …and the body it posted names no session and no folder.
      expect(apiCalls()[0]!.stdin).not.toContain("session_");
    } finally {
      fs.writeFileSync(cmdPath, original);
    }
    // And the file is back exactly as it was — this test leaves no trace.
    expect(fs.readFileSync(cmdPath, "utf-8")).toBe(original);
  });

  it("`repost` is not a force flag in disguise — it clears ONE refusal and no other", async () => {
    // The obvious way to reintroduce the hole R1 closed would be a flag the
    // AGENT sets that skips checks. `repost` re-arms a post the human already
    // authorized once; it is pinned here against every other refusal branch.
    const cases: Array<[string, Parameters<typeof handlePostPrReview>[0], Record<string, unknown>]> = [
      ["unruled findings", ctxFor([findings("art_1", "draft")]), { event: "COMMENT" }],
      ["APPROVE, changeset draft", ctxFor([findings("art_1", "approved"), changeset("cs_1", "draft", true)]), { event: "APPROVE" }],
      ["APPROVE, changeset rejected", ctxFor([findings("art_1", "approved"), changeset("cs_1", "rejected", true)]), { event: "APPROVE" }],
      ["junk event", ctxFor([findings("art_1", "approved")]), { event: "nope" }],
      ["soft REQUEST_CHANGES", ctxFor([findingsAt("art_1", "medium")]), { event: "REQUEST_CHANGES" }],
    ];
    for (const [label, ctx, args] of cases) {
      const res = await handlePostPrReview(ctx, { pr: "42", repost: true, ...args });
      expect(res.isError, label).toBe(true);
    }
    expect(calls()).toHaveLength(0);
  });
});
