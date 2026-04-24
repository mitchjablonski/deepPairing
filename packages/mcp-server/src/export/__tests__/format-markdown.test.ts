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

  describe("learnings format (R3)", () => {
    it("lists named concepts with their count and one-line explanation", () => {
      const state = makeState({
        artifacts: [
          makeArtifact("reasoning", "Use DI", {
            action: "Extract the cache into a repository",
            reasoning: "r",
            concept: { name: "dependency inversion", oneLineExplanation: "high-level code shouldn't depend on low-level details" },
            confidence: "high",
          }),
          {
            ...makeArtifact("reasoning", "Cache again", {
              action: "Wrap the prefetch in a repository",
              reasoning: "r",
              concept: { name: "dependency inversion" },
              confidence: "medium",
            }),
            id: "art_reasoning_2",
          },
          makeArtifact("reasoning", "Pin retry rate", {
            action: "Cap retries at 3 exponential",
            reasoning: "r",
            concept: { name: "exponential backoff", oneLineExplanation: "escalate wait time with each failure" },
            confidence: "high",
          }),
        ],
      });
      const md = formatSessionMarkdown(state, "learnings");
      expect(md).toContain("# Learnings");
      expect(md).toContain("## Concepts the pair named");
      expect(md).toContain("**dependency inversion**");
      expect(md).toContain("_(×2)_");
      expect(md).toContain("high-level code shouldn't depend on low-level details");
      expect(md).toContain("**exponential backoff**");
      // Recurring concepts sort first.
      expect(md.indexOf("dependency inversion")).toBeLessThan(md.indexOf("exponential backoff"));
    });

    it("cross-references predictions with retrospectives when present", () => {
      const state = {
        ...makeState({
          decisions: [{
            decisionId: "d1",
            artifactId: "art_decision_1",
            context: "Password hashing",
            options: [{ id: "a", title: "argon2id" }, { id: "b", title: "bcrypt" }],
            response: { optionId: "a", reasoning: "future-proof", predictedOutcome: "zero-downtime migration", confidence: "medium" },
          }],
        }),
        retrospectives: [{ id: "r1", decisionId: "d1", verdict: "right" as const, note: "rolled out clean" }],
      };
      const md = formatSessionMarkdown(state, "learnings");
      expect(md).toContain("## Predictions captured");
      expect(md).toContain("argon2id");
      expect(md).toContain("zero-downtime migration");
      expect(md).toContain("medium confidence");
      expect(md).toContain("✓ right");
      expect(md).toContain("rolled out clean");
    });

    it("surfaces rejected approaches from session memory with reasons", () => {
      const state: any = {
        ...makeState(),
        sessionMemory: {
          rejectedApproaches: [
            { description: "Deploy: Railway", reason: "too expensive", concept: "pay-per-request hosting" },
            { description: "Global mutable state", reason: "breaks testability" },
          ],
        },
      };
      const md = formatSessionMarkdown(state, "learnings");
      expect(md).toContain("## Approaches you won't re-propose");
      expect(md).toContain("**Deploy: Railway**");
      expect(md).toContain("_(concept: pay-per-request hosting)_");
      expect(md).toContain("too expensive");
      expect(md).toContain("**Global mutable state**");
      expect(md).toContain("breaks testability");
    });

    it("renders a 'nothing crystallized yet' line on an empty session", () => {
      const md = formatSessionMarkdown(makeState(), "learnings");
      expect(md).toContain("# Learnings");
      expect(md).toContain("Nothing crystallized yet");
    });
  });

  it("handles empty session gracefully", () => {
    const md = formatSessionMarkdown(makeState(), "full");
    expect(md).toContain("Session Report");
    // Should not throw on empty state
  });
});
