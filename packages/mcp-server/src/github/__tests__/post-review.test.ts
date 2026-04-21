import { describe, it, expect } from "vitest";
import { buildGitHubReviewPayload } from "../../export/format-markdown.js";
import { parsePrRef } from "../post-review.js";
import type { Artifact } from "@deeppairing/shared";

function researchArtifact(id: string, findings: any[], status: any = "approved"): Artifact {
  return {
    id,
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: "Auth audit",
    status,
    content: { summary: "x", findings },
    agentReasoning: null,
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z",
  };
}

function state(artifacts: Artifact[] = []) {
  return {
    sessionId: "session_abc",
    artifacts,
    comments: [],
    decisions: [],
    planReviews: [],
  };
}

describe("buildGitHubReviewPayload", () => {
  it("emits one comment per structured evidence location", () => {
    const payload = buildGitHubReviewPayload(state([
      researchArtifact("a1", [
        {
          category: "Security",
          title: "Weak hash",
          detail: "bcrypt rounds too low",
          severity: "high",
          significance: "high",
          impact: "brute force risk",
          recommendation: "switch to argon2id",
          evidence: [
            { filePath: "src/auth.ts", lineStart: 10, lineEnd: 12, snippet: "...", explanation: "only 10 rounds" },
            { filePath: "src/routes/login.ts", lineStart: 5, lineEnd: 5, snippet: "...", explanation: "same call site" },
          ],
        },
      ]),
    ]));

    expect(payload.comments).toHaveLength(2);
    expect(payload.comments[0].path).toBe("src/auth.ts");
    expect(payload.comments[0].line).toBe(12); // uses lineEnd
    expect(payload.comments[1].path).toBe("src/routes/login.ts");
  });

  it("includes severity chip, title, detail, impact, recommendation in the body", () => {
    const payload = buildGitHubReviewPayload(state([
      researchArtifact("a1", [
        {
          category: "Security",
          title: "Weak hash",
          detail: "bcrypt rounds too low",
          severity: "critical",
          significance: "high",
          impact: "brute force",
          recommendation: "argon2id",
          evidence: [
            { filePath: "auth.ts", lineStart: 1, lineEnd: 1, snippet: "x", explanation: "x" },
          ],
        },
      ]),
    ]));

    const body = payload.comments[0].body;
    expect(body).toContain("🔴"); // critical severity emoji
    expect(body).toContain("CRITICAL");
    expect(body).toContain("Weak hash");
    expect(body).toContain("bcrypt rounds too low");
    expect(body).toContain("**Impact:**");
    expect(body).toContain("brute force");
    expect(body).toContain("**Recommendation:**");
    expect(body).toContain("argon2id");
  });

  it("omits findings without structured evidence", () => {
    const payload = buildGitHubReviewPayload(state([
      researchArtifact("a1", [
        // String evidence — no filePath/line, skipped
        { category: "Note", detail: "general observation", significance: "low", evidence: "see README" },
        // Structured
        {
          category: "Perf",
          detail: "slow",
          significance: "medium",
          evidence: [{ filePath: "slow.ts", lineStart: 3, lineEnd: 3, snippet: "x", explanation: "x" }],
        },
      ]),
    ]));
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].path).toBe("slow.ts");
  });

  it("omits rejected / retracted / superseded research artifacts", () => {
    const ev = [{ filePath: "a.ts", lineStart: 1, lineEnd: 1, snippet: "x", explanation: "x" }];
    const payload = buildGitHubReviewPayload(state([
      researchArtifact("a1", [{ category: "x", detail: "x", significance: "low", evidence: ev }], "rejected"),
      researchArtifact("a2", [{ category: "y", detail: "y", significance: "low", evidence: ev }], "retracted"),
      researchArtifact("a3", [{ category: "z", detail: "z", significance: "low", evidence: ev }], "superseded"),
      researchArtifact("a4", [{ category: "ok", detail: "ok", significance: "low", evidence: ev }]),
    ]));
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].body).toContain("ok");
  });

  it("defaults event to COMMENT", () => {
    expect(buildGitHubReviewPayload(state()).event).toBe("COMMENT");
  });

  it("honors explicit event (REQUEST_CHANGES)", () => {
    const payload = buildGitHubReviewPayload(state(), { event: "REQUEST_CHANGES" });
    expect(payload.event).toBe("REQUEST_CHANGES");
  });

  it("body summarizes empty-findings state", () => {
    const payload = buildGitHubReviewPayload(state());
    expect(payload.body).toContain("deepPairing notes");
    expect(payload.body).toContain("No reviewable findings");
  });

  it("body lists finding titles when present", () => {
    const payload = buildGitHubReviewPayload(state([
      researchArtifact("a1", [
        {
          category: "x",
          title: "Weak hashing",
          detail: "x",
          significance: "low",
          evidence: [{ filePath: "a.ts", lineStart: 1, lineEnd: 1, snippet: "x", explanation: "x" }],
        },
      ]),
    ]));
    expect(payload.body).toContain("Weak hashing");
    expect(payload.body).toContain(payload.comments.length.toString());
  });
});

describe("parsePrRef", () => {
  it("parses a bare number", () => {
    expect(parsePrRef("42")).toEqual({ number: 42 });
  });

  it("parses a # prefixed number", () => {
    expect(parsePrRef("#42")).toEqual({ number: 42 });
  });

  it("parses a full GitHub URL", () => {
    expect(parsePrRef("https://github.com/anthropic/deeppairing/pull/123")).toEqual({
      owner: "anthropic",
      repo: "deeppairing",
      number: 123,
    });
  });

  it("throws on unparseable input", () => {
    expect(() => parsePrRef("not-a-pr")).toThrow(/Could not parse/);
  });
});
