import { describe, it, expect } from "vitest";
import { formatSessionMarkdown } from "../format-markdown.js";
import type { Artifact, Comment } from "@deeppairing/shared";

function makeState(overrides: {
  artifacts?: Artifact[];
  comments?: Comment[];
  decisions?: any[];
  planReviews?: any[];
} = {}) {
  return {
    sessionId: "test_session",
    artifacts: overrides.artifacts ?? [],
    comments: overrides.comments ?? [],
    decisions: overrides.decisions ?? [],
    planReviews: overrides.planReviews ?? [],
  };
}

function makeArtifact(type: string, title: string, content: any, status = "approved"): Artifact {
  return {
    id: `art_${type}_1`,
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

describe("formatSessionMarkdown", () => {
  describe("pr-description format", () => {
    it("includes decisions and plan steps", () => {
      const state = makeState({
        artifacts: [
          makeArtifact("plan", "Auth Refactor", {
            steps: [{ description: "Create service", files: ["/src/auth.ts"], reasoning: "Clean" }],
          }),
        ],
        decisions: [{
          decisionId: "d1",
          artifactId: "a1",
          context: "Pattern choice",
          options: [{ id: "a", title: "Service" }, { id: "b", title: "Inline" }],
          response: { optionId: "a", reasoning: "Cleaner" },
          createdAt: "2026-01-01T00:00:00Z",
        }],
      });

      const md = formatSessionMarkdown(state, "pr-description");
      expect(md).toContain("## Summary");
      expect(md).toContain("Pattern choice");
      expect(md).toContain("Service");
      expect(md).toContain("Create service");
      expect(md).toContain("deepPairing");
    });

    it("includes high-significance findings", () => {
      const state = makeState({
        artifacts: [
          makeArtifact("research", "Security Audit", {
            summary: "Issues found",
            findings: [
              { category: "Security", title: "Weak Hashing", detail: "bcrypt 10 rounds", significance: "high" },
              { category: "Style", title: "Naming", detail: "Minor", significance: "low" },
            ],
          }),
        ],
      });

      const md = formatSessionMarkdown(state, "pr-description");
      expect(md).toContain("Weak Hashing");
      expect(md).not.toContain("Naming"); // Low significance excluded
    });
  });

  describe("adr format", () => {
    it("includes context, decision, and consequences", () => {
      const state = makeState({
        artifacts: [
          makeArtifact("research", "Analysis", {
            summary: "Auth needs work",
            findings: [{ category: "Security", title: "Weak Hashing", detail: "10 rounds", impact: "Crackable" }],
          }),
          makeArtifact("plan", "Plan", {
            steps: [{ description: "Add argon2", reasoning: "OWASP recommended" }],
          }),
        ],
        decisions: [{
          decisionId: "d1",
          artifactId: "a1",
          context: "Hash algorithm",
          options: [
            { id: "a", title: "Argon2", description: "Modern" },
            { id: "b", title: "Bcrypt 12", description: "Incremental" },
          ],
          response: { optionId: "a", reasoning: "Future-proof" },
          createdAt: "2026-01-01T00:00:00Z",
        }],
      });

      const md = formatSessionMarkdown(state, "adr");
      expect(md).toContain("# ADR:");
      expect(md).toContain("## Context");
      expect(md).toContain("## Decision");
      expect(md).toContain("Argon2");
      expect(md).toContain("Rejected alternatives");
      expect(md).toContain("Bcrypt 12");
      expect(md).toContain("## Consequences");
    });
  });

  describe("full format", () => {
    it("includes all sections with code evidence", () => {
      const state = makeState({
        artifacts: [
          makeArtifact("research", "Audit", {
            summary: "Issues found",
            findings: [{
              category: "Security",
              title: "Weak Hash",
              detail: "10 rounds",
              significance: "high",
              evidence: [{
                filePath: "/src/auth.ts",
                lineStart: 5,
                lineEnd: 8,
                snippet: "bcrypt.hash(pw, 10)",
                language: "typescript",
                explanation: "Only 10 rounds",
              }],
              impact: "Crackable",
              recommendation: "Use argon2",
            }],
          }),
          makeArtifact("reasoning", "Reasoning", {
            action: "Create service",
            reasoning: "Clean separation",
            confidence: "high",
          }),
        ],
        comments: [{
          id: "c1",
          sessionId: "test_session",
          target: { artifactId: "art_research_1" },
          parentCommentId: null,
          author: "human" as const,
          content: "Agree, this is critical",
          acknowledged: false,
          createdAt: "2026-01-01T00:00:00Z",
        }],
      });

      const md = formatSessionMarkdown(state, "full");
      expect(md).toContain("# deepPairing Session Report");
      expect(md).toContain("## Findings");
      expect(md).toContain("bcrypt.hash(pw, 10)");
      expect(md).toContain("```typescript");
      expect(md).toContain("**Impact**: Crackable");
      expect(md).toContain("Reasoning Log");
    });
  });

  it("handles empty session gracefully", () => {
    const md = formatSessionMarkdown(makeState(), "full");
    expect(md).toContain("Session Report");
    // Should not throw on empty state
  });
});
