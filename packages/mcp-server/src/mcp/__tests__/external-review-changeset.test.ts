/**
 * Q6 (#232) — the EXTERNAL-REVIEW changeset, end to end through the real MCP
 * server.
 *
 * The user's ask was "help me review a PR I got pinged on, and work through the
 * risks with the agent". The mechanism is one flag: `reviewIntent: "external"`
 * on present_changeset puts a colleague's diff on the rich review surface.
 *
 * The flag is only worth anything if the surrounding machinery stops treating
 * that diff as CODE THAT IS ABOUT TO LAND. This file pins each place that had
 * to change, and — just as importantly — each place that must NOT have:
 *
 *   1. the content carries the new fields, and a local changeset's content is
 *      still byte-identical to a pre-Q6 one;
 *   2. the closing instruction flips (post the review, not "end with a
 *      debrief") and never tells the agent to apply or redraft;
 *   3. the rejected-approach BLOCK is skipped — your stance about your own
 *      codebase must not be able to hide a colleague's PR from you — while the
 *      identical LOCAL changeset is still blocked;
 *   4. check_feedback's debrief nag stays silent for a review-only session and
 *      fires the moment real local work appears.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { coerceChangesetContent } from "@deeppairing/shared";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

const PR_FILES = [
  {
    path: "src/limiter.ts",
    changeType: "added",
    hunks: [{ header: "@@ -0,0 +1,9 @@", lines: [{ kind: "add", content: "const buckets = new Map()", newLine: 3 }] }],
  },
  {
    path: "src/server.ts",
    changeType: "modified",
    hunks: [{ header: "@@ -12,6 +12,9 @@", lines: [{ kind: "add", content: "app.use(limiter)", newLine: 14 }] }],
  },
];

const SOURCE = {
  kind: "github-pr",
  number: 123,
  url: "https://github.com/acme/widgets/pull/123",
  headRef: "feat/rate-limit",
  baseRef: "main",
  author: "dana",
  headSha: "0123456789abcdef0123456789abcdef01234567",
};

async function presentExternal(extra: Record<string, unknown> = {}) {
  return callTool("present_changeset", {
    title: "PR #123 — in-process rate limiting",
    summary: "Adds a token-bucket limiter in front of the API.",
    files: PR_FILES,
    reviewIntent: "external",
    source: SOURCE,
    ...extra,
  });
}

function theChangeset() {
  const a = store.getArtifacts().find((x) => x.type === "changeset");
  expect(a, "no changeset artifact was created").toBeDefined();
  return a!;
}

describe("Q6 — present_changeset accepts and persists the external-review fields", () => {
  it("round-trips reviewIntent + the full github-pr source onto the artifact", async () => {
    const res = await presentExternal();
    expect(res.isError).toBeFalsy();

    const content = coerceChangesetContent(theChangeset().content);
    expect(content.reviewIntent).toBe("external");
    expect(content.source).toEqual(SOURCE);
    // The diff itself is ordinary changeset content — that is the point. Every
    // affordance the surface already has (per-hunk comments, walk-me-through,
    // per-file disposition) works on a PR for free.
    expect(content.files.map((f) => f.path)).toEqual(["src/limiter.ts", "src/server.ts"]);
  });

  it("a LOCAL changeset's content is unchanged — no reviewIntent key is defaulted in", async () => {
    // Back-compat at the tool boundary, not just the coercer: an ordinary
    // present_changeset call must write exactly what it wrote before Q6.
    await callTool("present_changeset", { title: "Move TTL refresh into middleware", files: PR_FILES });
    const raw = theChangeset().content as Record<string, unknown>;
    expect("reviewIntent" in raw).toBe(false);
    expect("source" in raw).toBe(false);
    expect(Object.keys(raw).sort()).toEqual(["files"]);
  });

  it("an invalid reviewIntent is a validation error, not a silent downgrade to local", async () => {
    // Silently treating "externl" as local would be the worst outcome: the
    // human gets the landing-gate semantics on someone else's code with no
    // warning anywhere.
    const res = await callTool("present_changeset", {
      title: "PR #123", files: PR_FILES, reviewIntent: "externl",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("INPUT_VALIDATION_FAILED");
    expect(store.getArtifacts().filter((a) => a.type === "changeset")).toHaveLength(0);
  });

  it("#343 normalizes a valid head SHA and rejects malformed new provenance", async () => {
    const upper = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    const accepted = await presentExternal({ source: { ...SOURCE, headSha: upper } });
    expect(accepted.isError).toBeFalsy();
    expect(coerceChangesetContent(theChangeset().content).source?.headSha).toBe(upper.toLowerCase());

    const malformed = await presentExternal({ source: { ...SOURCE, headSha: "abc123" } });
    expect(malformed.isError).toBe(true);
    expect(malformed.text).toContain("INPUT_VALIDATION_FAILED");
  });
});

describe("Q6 — the closing instruction the agent is given", () => {
  it("an external changeset says POST THE REVIEW and never 'end with present_debrief'", async () => {
    const res = await presentExternal();
    expect(res.text).toContain("EXTERNAL review");
    expect(res.text).toContain("PR #123");
    expect(res.text).toContain("by dana");
    expect(res.text).toContain("0123456789ab");
    expect(res.text).toContain("post_pr_review");
    // The three things that must not be misread.
    expect(res.text).toMatch(/stay LOCAL|stays LOCAL/);
    expect(res.text).toContain("Do NOT apply");
    expect(res.text).not.toContain("end with present_debrief");
    expect(res.text).toContain("No present_debrief is owed");
  });

  it("a LOCAL changeset keeps the ordinary debrief close, verbatim", async () => {
    const res = await callTool("present_changeset", { title: "Move TTL refresh", files: PR_FILES });
    expect(res.text).toContain("When the feature wraps, end with present_debrief.");
    expect(res.text).not.toContain("EXTERNAL review");
    expect(res.text).not.toContain("post_pr_review");
  });

  it("names the PR generically when no source was supplied (no fabricated number)", async () => {
    const res = await callTool("present_changeset", {
      title: "Someone's PR", files: PR_FILES, reviewIntent: "external",
    });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("EXTERNAL review — the PR with NO immutable head SHA recorded");
    expect(res.text).toContain("is someone else's code");
    expect(res.text).not.toMatch(/PR #\d/);
  });
});

describe("Q6 — the rejected-approach gate points OUTWARD, not inward", () => {
  const REJECTION = {
    description: "in-process rate limiting",
    reason: "we standardised on the edge limiter; in-process drifts per instance",
    concept: "in-process rate limiting",
  };

  it("a stance about YOUR codebase cannot block you from seeing a colleague's PR", async () => {
    // The failure this prevents: the human is pinged on a PR, the agent tries to
    // show it, the gate refuses because the PR happens to use a pattern the
    // human once rejected — and there is no revision that could ever unblock it,
    // because you cannot revise someone else's pull request.
    store.recordRejectedApproach(REJECTION);

    const res = await callTool("present_changeset", {
      title: "PR #123 — in-process rate limiting",
      summary: "Adds an in-process rate limiting layer.",
      files: PR_FILES,
      reviewIntent: "external",
      source: SOURCE,
    });

    expect(res.isError).toBeFalsy();
    expect(theChangeset()).toBeDefined();

    // R1 (#279) — the invariant above is unchanged: not refused, artifact
    // created. What changed is what happens to the MATCH. Q6 implemented
    // "must not block" as "must not run", which switched the human's taste gate
    // off on the strength of one unverifiable flag in the agent's own tool
    // call. Now the matcher runs and its result comes back as ADVICE, which the
    // agent is told to raise WITH the human as an internal-audience finding —
    // never on the PR.
    expect(res.text).toContain("advisory, not a block");
    expect(res.text).toContain("in-process rate limiting");
    expect(res.text).toContain('audience: "internal"');
    // And the advice is not dressed as a refusal anywhere.
    expect(res.text).not.toMatch(/REJECTED_APPROACH_BLOCKED[\s\S]*Refusing/);
  });

  it("…and the IDENTICAL changeset as the agent's own proposal is still blocked", async () => {
    // The control. If this passes too, the carve-out ate the gate.
    store.recordRejectedApproach(REJECTION);

    const res = await callTool("present_changeset", {
      title: "Add in-process rate limiting",
      summary: "Adds an in-process rate limiting layer.",
      files: PR_FILES,
    });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/rejected/i);
    expect(store.getArtifacts().filter((a) => a.type === "changeset")).toHaveLength(0);
  });

  it("a preflight trace IS recorded for an external review — the stances were weighed", async () => {
    // Q6 asserted the opposite here, on the reasoning that "no proposal was
    // weighed, so a breadcrumb claiming otherwise would be a false record".
    // R1 (#279) makes that premise false: the matcher now runs on external
    // changesets (advisory), so the stances genuinely WERE weighed and the
    // breadcrumb is the honest record of it. What the trace must never claim is
    // that the call was REFUSED — see the advisory pin above.
    store.recordRejectedApproach({ description: "unrelated thing", reason: "no", concept: "unrelated thing" });
    await presentExternal();
    const trace = await store.getPreflightTrace?.(theChangeset().id);
    expect(trace).toBeTruthy();
    expect(trace!.consideredCount).toBe(1);
    expect(trace!.decision).toBe("admitted");
  });

  it("CONTROL — a local changeset in the same store DOES get a trace", async () => {
    store.recordRejectedApproach({ description: "unrelated thing", reason: "no", concept: "unrelated thing" });
    await callTool("present_changeset", { title: "Move TTL refresh", files: PR_FILES });
    expect(await store.getPreflightTrace?.(theChangeset().id)).toBeTruthy();
  });
});

describe("Q6 — the debrief gate does not count someone else's code", () => {
  it("a review-only session is never nagged to present a debrief", async () => {
    await presentExternal();
    // Clear the changeset out of "pending" so the nag's winding-down gate is
    // open — otherwise this would pass for the wrong reason (mid-flight, not
    // carved out). Verify-the-instrument: the control below shares this setup.
    await store.updateArtifactStatus(theChangeset().id, "approved", "ui_approve_button" as never);

    const res = await callTool("check_feedback");
    expect(res.text).not.toContain("present_debrief");
    expect(res.text).not.toContain("code was presented");
  });

  it("CONTROL — the same session with a LOCAL changeset IS nagged", async () => {
    // Same shape, same statuses, one field different. If this control ever goes
    // quiet, the test above proves nothing.
    await callTool("present_changeset", { title: "Move TTL refresh", files: PR_FILES });
    await store.updateArtifactStatus(theChangeset().id, "approved", "ui_approve_button" as never);

    const res = await callTool("check_feedback");
    expect(res.text).toContain("present_debrief");
  });

  it("reviewing a PR does not escalate the pair's own single-file fix out of TRIVIAL", async () => {
    await presentExternal();
    await store.updateArtifactStatus(theChangeset().id, "approved", "ui_approve_button" as never);
    await callTool("present_code_change", {
      filePath: "src/notes.ts", after: "// jotted while reviewing\n",
      reasoning: "A one-line note I made while reading their PR.",
      title: "Note the limiter's bucket key",
    });
    for (const a of store.getArtifacts().filter((x) => x.type === "code_change")) {
      await store.updateArtifactStatus(a.id, "approved", "ui_approve_button" as never);
    }

    const res = await callTool("check_feedback");
    // The colleague's diff says nothing about how big YOUR own change was.
    expect(res.text).not.toContain("code was presented but no present_debrief");
  });
});
