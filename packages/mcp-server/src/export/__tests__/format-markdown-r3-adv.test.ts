/**
 * R3 (adversarial F8) — the shipped-status predicate on the paths that leave
 * the building, including the one that POSTS to a stranger's PR.
 *
 * `isShippedArtifact` omitted `obsolete` in three more hand-copies:
 * buildGitHubReviewPayload (posts review comments to GitHub) and
 * formatPrComments (pasted onto a PR). And pr-description/adr never marked
 * never-approved work, so a draft plan read as shipped consensus.
 */
import { describe, it, expect } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { buildGitHubReviewPayload, formatSessionMarkdown } from "../format-markdown.js";

function art(type: string, title: string, content: any, status = "approved"): Artifact {
  return {
    id: `art_${type}_${Math.random().toString(36).slice(2, 7)}`,
    sessionId: "test_session",
    type: type as any,
    version: 1,
    parentId: null,
    title,
    status: status as any,
    content,
    agentReasoning: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}
function state(artifacts: Artifact[]) {
  return { sessionId: "test_session", artifacts, comments: [], decisions: [], planReviews: [] };
}

const obsoleteResearch = () =>
  art("research", "Overtaken audit", {
    summary: "Overtaken.",
    findings: [{ category: "Perf", title: "Poll the queue every second", detail: "d", significance: "high", evidence: [{ filePath: "q.ts", lineStart: 3, snippet: "poll()" }] }],
  }, "obsolete");

describe("F8 — obsolete work is dropped from the POST paths", () => {
  it("pr-comments drops an obsolete finding", () => {
    const md = formatSessionMarkdown(state([obsoleteResearch()]), "pr-comments");
    expect(md).not.toContain("Poll the queue every second");
  });

  it("buildGitHubReviewPayload drops an obsolete finding (it posts to a stranger's PR)", () => {
    const payload = buildGitHubReviewPayload(state([obsoleteResearch()]) as any);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Poll the queue every second");
    expect(payload.comments.length).toBe(0);
  });

  it("buildGitHubReviewPayload still posts an APPROVED finding", () => {
    const approved = art("research", "Live audit", {
      summary: "Live.",
      findings: [{ category: "Sec", title: "Missing rate limit", detail: "d", significance: "high", evidence: [{ filePath: "a.ts", lineStart: 1, snippet: "x" }] }],
    });
    const payload = buildGitHubReviewPayload(state([approved]) as any);
    expect(JSON.stringify(payload)).toContain("Missing rate limit");
  });
});

// S4 (round-14) — the last outbound-leak asymmetry. R1 scrubbed the session id
// off the posted body and R3 scrubs the share page's prose, but the finding
// BODIES posted to a stranger's PR were verbatim. An absolute path the agent
// typed into a detail/explanation/recommendation named the reviewer's disk to a
// third party. scrubProse now runs over each body field on the outbound path.
describe("S4 — outbound finding bodies are scrubbed of machine paths", () => {
  const leaky = () =>
    art("research", "Path leak audit", {
      summary: "Live.",
      findings: [
        {
          category: "Sec",
          title: "Token stored in /home/mitch/dev/app/secrets.json",
          detail: "The path /home/mitch/dev/app/secrets.json is read at boot.",
          significance: "high",
          impact: "Anyone with C:\\Users\\mitch\\dev\\app can read it.",
          recommendation: "Move it out of /home/mitch/dev/app entirely.",
          evidence: [
            {
              filePath: "app/boot.ts",
              lineStart: 12,
              snippet: "read()",
              explanation: "Traced through /home/mitch/dev/app/boot.ts.",
            },
          ],
        },
      ],
    });

  it("a /home/<user> or C:\\Users path in a finding body is collapsed in the posted body", () => {
    const payload = buildGitHubReviewPayload(state([leaky()]) as any);
    const serialized = JSON.stringify(payload);
    // The leak is gone from every outbound field...
    expect(serialized).not.toContain("/home/mitch");
    expect(serialized).not.toContain("C:\\\\Users\\\\mitch");
    expect(serialized).not.toContain("Users\\\\mitch");
    // ...but the finding still posts, collapsed to the home marker.
    expect(payload.comments.length).toBe(1);
    expect(serialized).toContain("~/");
  });

  it("ordinary finding prose is posted byte-identical (scrub is a no-op for it)", () => {
    const clean = art("research", "Clean audit", {
      summary: "Live.",
      findings: [{ category: "Perf", title: "N+1 in the list view", detail: "The loop issues one query per row.", significance: "high", evidence: [{ filePath: "list.ts", lineStart: 4, snippet: "q()" }] }],
    });
    const payload = buildGitHubReviewPayload(state([clean]) as any);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("The loop issues one query per row.");
    expect(serialized).toContain("N+1 in the list view");
  });
});

describe("F8 — never-approved work is marked, not presented as shipped", () => {
  it("a draft plan is marked '(not approved …)' in pr-description", () => {
    const draftPlan = art("plan", "Rate limiter rollout", { steps: [{ description: "Add a token bucket", reasoning: "burst control" }] }, "draft");
    const md = formatSessionMarkdown(state([draftPlan]), "pr-description");
    expect(md).toContain("Rate limiter rollout");
    expect(md).toContain("not approved");
    expect(md).toContain("still a draft");
  });

  it("a sent-back (revised) plan is marked accordingly", () => {
    const revisedPlan = art("plan", "Cutover", { steps: [{ description: "Flip the flag", reasoning: "reversible" }] }, "revised");
    const md = formatSessionMarkdown(state([revisedPlan]), "pr-description");
    expect(md).toContain("sent back for changes");
  });

  it("an approved plan carries no marker (byte-clean for the normal run)", () => {
    const approvedPlan = art("plan", "Shipped plan", { steps: [{ description: "Do it", reasoning: "why" }] });
    const md = formatSessionMarkdown(state([approvedPlan]), "pr-description");
    expect(md).toContain("Shipped plan");
    expect(md).not.toContain("not approved");
  });
});
