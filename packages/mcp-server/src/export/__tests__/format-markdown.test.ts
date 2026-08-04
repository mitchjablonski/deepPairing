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

    it("does NOT emit a predictions section even when a legacy decision carries a predictedOutcome (#194 cut)", () => {
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
      };
      const md = formatSessionMarkdown(state, "learnings");
      expect(md).not.toContain("## Predictions captured");
      expect(md).not.toContain("zero-downtime migration");
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

  // #192 (coverage H1) — the comprehension artifacts (debrief, explainer) plus
  // the older-omitted spec + changeset now reach the exports that should carry
  // them. The debrief IS the session digest; export `full` IS the session report.
  describe("#192 — comprehension artifacts in exports", () => {
    const debrief = makeArtifact("debrief", "Auth refactor debrief", {
      summary: "You moved session validation into a shared guard.",
      sections: [{
        title: "The guard",
        body: "Extracted requireSession into middleware.",
        concepts: [{ name: "middleware chaining", oneLineExplanation: "compose per-request checks" }],
        evidence: [{ filePath: "/src/guard.ts", lineStart: 1, lineEnd: 3, snippet: "export const requireSession", language: "typescript", explanation: "the new guard" }],
      }],
      decisionsMade: [{ what: "Kept cookie sessions", why: "no client change needed", alternative: "JWT" }],
      needsYourEyes: [{ what: "The 401 redirect target", why: "product-specific" }],
      deferred: [{ what: "Rate limiting", why: "out of scope this pass" }],
      openQuestions: ["Should logout clear all sessions or just this one?"],
    });
    const explainer = makeArtifact("explainer", "How auth works", {
      title: "How authentication works here",
      overview: "A walk-through of the request auth path.",
      sections: [{ heading: "Entry", body: "Requests hit the guard first.", evidence: [{ filePath: "/src/guard.ts", lineStart: 5, lineEnd: 9, snippet: "if (!session) throw", explanation: "the gate" }] }],
    });

    it("formatFull renders debrief (five lanes) + explainer sections", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [debrief, explainer] }), "full");
      expect(md).toContain("## Debrief — Auth refactor debrief");
      expect(md).toContain("You moved session validation into a shared guard.");
      expect(md).toContain("### Decisions I made without you");
      expect(md).toContain("Kept cookie sessions");
      expect(md).toContain("### Needs your eyes");
      expect(md).toContain("### Deferred");
      expect(md).toContain("### Open questions");
      expect(md).toContain("middleware chaining");
      expect(md).toContain("```typescript");
      // Explainer
      expect(md).toContain("## Explainer — How authentication works here");
      expect(md).toContain("A walk-through of the request auth path.");
      expect(md).toContain("### 1. Entry");
    });

    it("formatFull renders spec + changeset sections", () => {
      const spec = makeArtifact("spec", "Session guard spec", {
        objective: "Centralize session checks",
        requirements: [{ id: "REQ-1", statement: "All routes require a session", rationale: "security", acceptanceCriteria: ["401 without a cookie"], priority: "must" }],
      });
      const changeset = makeArtifact("changeset", "Guard changeset", {
        summary: "Two files touched",
        files: [{ path: "/src/guard.ts", changeType: "added", hunks: [{ header: "@@ -0,0 +1,3 @@", lines: [{ kind: "add", content: "export const requireSession = () => {}" }] }] }],
      });
      const md = formatSessionMarkdown(makeState({ artifacts: [spec, changeset] }), "full");
      expect(md).toContain("## Spec — Session guard spec");
      expect(md).toContain("**REQ-1**");
      expect(md).toContain("All routes require a session");
      expect(md).toContain("## Changeset — Guard changeset");
      expect(md).toContain("```diff");
      expect(md).toContain("+export const requireSession");
    });

    it("formatLearnings folds in the debrief's decisions-made / deferred / open questions", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [debrief] }), "learnings");
      expect(md).toContain("## From the debrief");
      expect(md).toContain("### Calls the agent made on its own");
      expect(md).toContain("Kept cookie sessions");
      expect(md).toContain("### Deferred");
      expect(md).toContain("Rate limiting");
      expect(md).toContain("### Still open");
      expect(md).toContain("Should logout clear all sessions");
      // A debrief alone means the session is NOT "nothing crystallized yet".
      expect(md).not.toContain("Nothing crystallized yet");
    });

    it("formatPrDescription leads with the debrief summary + what-needs-review", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [debrief] }), "pr-description");
      expect(md).toContain("You moved session validation into a shared guard.");
      expect(md).toContain("**What needs review:**");
      expect(md).toContain("The 401 redirect target");
    });

    // DESIGN CHOICE (documented): the ADR deliberately OMITS the debrief. An ADR
    // is a decision record — its Context/Decision/Consequences already come from
    // findings + resolved decisions + plan; a change-narrative digest doesn't fit
    // that format's purpose and would dilute it. PR description + full report DO
    // carry it (a PR benefits from the summary). This pins the omission.
    it("formatAdr does NOT inject the debrief narrative (decision record, not a change digest)", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [debrief] }), "adr");
      expect(md).not.toContain("## Debrief");
      expect(md).not.toContain("You moved session validation into a shared guard.");
    });

    it("a session WITHOUT the new types produces no new headers (existing exports unchanged)", () => {
      const research = makeArtifact("research", "Audit", { summary: "s", findings: [{ category: "Sec", detail: "d", significance: "high" }] });
      const md = formatSessionMarkdown(makeState({ artifacts: [research] }), "full");
      expect(md).not.toContain("## Debrief");
      expect(md).not.toContain("## Explainer");
      expect(md).not.toContain("## Spec");
      expect(md).not.toContain("## Changeset");
    });
  });
});
