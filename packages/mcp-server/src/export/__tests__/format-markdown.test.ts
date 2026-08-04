import { describe, it, expect } from "vitest";
import { formatSessionMarkdown, neutralizeVoice } from "../format-markdown.js";
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

    it("formatPrDescription leads with the debrief summary + what-needs-review (neutralized, #196 M1)", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [debrief] }), "pr-description");
      // F2 (M1) — the pair-voice "You moved…" is neutralized for the teammate
      // reading the PR; no second-person address survives.
      expect(md).not.toContain("You moved session validation");
      expect(md).toContain("The reviewer moved session validation into a shared guard.");
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

    // F2 (#196 M2) — debrief markdown defects.
    it("formatFull renames the walk-lane group header to Walkthrough (no 'What changed' collision)", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [debrief] }), "full");
      expect(md).toContain("### Walkthrough");
      expect(md).not.toContain("### What changed");
    });

    it("formatFull does not double-prefix a debrief whose title already carries the word", () => {
      const prefixed = makeArtifact("debrief", "Debrief — auth refactor", {
        summary: "A summary.",
        sections: [{ title: "The guard", body: "b" }],
      });
      const md = formatSessionMarkdown(makeState({ artifacts: [prefixed] }), "full");
      expect(md).toContain("## Debrief — auth refactor");
      expect(md).not.toContain("Debrief — Debrief");
    });
  });

  // F2 (#196 H1) — rejected/retracted work must not read as SHIPPED. External
  // formats (pr-description, adr) drop it entirely; the full record keeps it but
  // marks it "Rejected (not built)". Shaped after the demo's rejected
  // ConfigStore-singleton finding (demo-script.ts) — the executed repro.
  describe("#196 F2 — rejected work is not shipped-as-built", () => {
    const rejectedResearch = makeArtifact(
      "research",
      "Config loader refactor — proposed approach",
      {
        summary: "Add a global mutable state singleton for config access across services.",
        findings: [{
          category: "Architecture",
          title: "Introduce ConfigStore global singleton",
          detail: "A shared mutable ConfigStore would cache config across services.",
          significance: "high",
          severity: "medium",
          recommendation: "Add a ConfigStore class exported as a singleton.",
        }],
      },
      "rejected",
    );

    it("pr-description EXCLUDES a rejected finding entirely (demo repro)", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [rejectedResearch] }), "pr-description");
      expect(md).not.toContain("Introduce ConfigStore global singleton");
      expect(md).not.toContain("### Key Findings");
    });

    it("adr EXCLUDES rejected research from Context", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [rejectedResearch] }), "adr");
      expect(md).not.toContain("Introduce ConfigStore global singleton");
      expect(md).not.toContain("global mutable state singleton");
    });

    it("full INCLUDES the rejected finding but marks it 'Rejected (not built)'", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [rejectedResearch] }), "full");
      expect(md).toContain("Introduce ConfigStore global singleton");
      expect(md).toContain("Rejected (not built)");
      // The marker precedes the finding it applies to.
      expect(md.indexOf("Rejected (not built)")).toBeLessThan(md.indexOf("Introduce ConfigStore global singleton"));
    });

    it("a retracted plan is dropped from pr-description but marked in full", () => {
      const retractedPlan = makeArtifact("plan", "Risky migration", {
        steps: [{ description: "Drop the users table", reasoning: "start clean" }],
      }, "retracted");
      const pr = formatSessionMarkdown(makeState({ artifacts: [retractedPlan] }), "pr-description");
      expect(pr).not.toContain("Drop the users table");
      const full = formatSessionMarkdown(makeState({ artifacts: [retractedPlan] }), "full");
      expect(full).toContain("Drop the users table");
      expect(full).toContain("Rejected (not built)");
    });

    it("approved work still ships clean (no marker leaks onto a normal run)", () => {
      const approved = makeArtifact("research", "Audit", {
        summary: "Clean.",
        findings: [{ category: "Sec", title: "Real issue", detail: "d", significance: "high" }],
      });
      const full = formatSessionMarkdown(makeState({ artifacts: [approved] }), "full");
      expect(full).toContain("Real issue");
      expect(full).not.toContain("Rejected (not built)");
      const pr = formatSessionMarkdown(makeState({ artifacts: [approved] }), "pr-description");
      expect(pr).toContain("Real issue");
    });
  });

  // F2 (#196 M1) — neutral voice for external formats only.
  describe("#196 F2 — neutral voice for external formats", () => {
    const voiceDebrief = makeArtifact("debrief", "Config loader debrief", {
      summary: "You rejected the global ConfigStore, so I pivoted to a lazy loader.",
      needsYourEyes: [{ what: "The retry cap", why: "product-specific" }],
    });

    it("pr-description strips second-person pair voice", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [voiceDebrief] }), "pr-description");
      expect(md).not.toMatch(/\bYou\b/);
      expect(md).not.toMatch(/\bI\b/);
      expect(md).toContain("The reviewer rejected the global ConfigStore");
      expect(md).toContain("the agent pivoted to a lazy loader");
    });

    it("full export KEEPS the pair voice (faithful session record)", () => {
      const md = formatSessionMarkdown(makeState({ artifacts: [voiceDebrief] }), "full");
      expect(md).toContain("You rejected the global ConfigStore, so I pivoted to a lazy loader.");
    });
  });

  // F2 (#196 M1, hardened in review #232) — neutralizeVoice must not mangle
  // ordinary pair prose. The pre-fix rules glued "'re"/"'ll" onto noun phrases,
  // rewrote code identifiers, and split "I/O". These pin the fixes.
  describe("#196 F2 — neutralizeVoice hostile repro", () => {
    // A glued contraction ("the pair're", "the reviewer'll") is a rule gap.
    // NB: possessives ("the reviewer's", "the pair's") are LEGITIMATE, so the
    // guard targets contraction remnants (re|ll|ve|d) only — not a bare "'".
    const GLUED = /\bthe (?:reviewer|pair|agent)['’](?:re|ll|ve|d)\b/;

    it("expands you/we/I contractions instead of gluing them onto a noun phrase", () => {
      const out = neutralizeVoice("We're refactoring so you'll get testable config; you've seen we'll batch it, and we'd cache your results. I've moved it and I'd defer the rest.");
      expect(out).not.toMatch(GLUED);
      expect(out).toContain("The pair is refactoring");
      expect(out).toContain("the reviewer will get testable config");
      expect(out).toContain("the reviewer has seen");
      expect(out).toContain("the pair will batch it");
      expect(out).toContain("the pair would cache the reviewer's results");
      expect(out).toContain("The agent has moved it");
      expect(out).toContain("the agent would defer the rest");
    });

    it("leaves code identifiers untouched — inline spans AND fenced blocks", () => {
      const inline = neutralizeVoice("Call `you.method()` to read your config.");
      expect(inline).toContain("`you.method()`");
      expect(inline).toContain("the reviewer's config");
      const fenced = neutralizeVoice("```ts\nconst you = 1; // we keep this and your setting\n```\nAfter, you review it.");
      expect(fenced).toContain("const you = 1; // we keep this and your setting");
      expect(fenced).toContain("the reviewer review it"); // prose after the block IS transformed
      expect(fenced).not.toMatch(GLUED);
    });

    it("does not split 'I/O' (slash-adjacent capital I is not a pronoun)", () => {
      const out = neutralizeVoice("I/O bound work: you've profiled it.");
      expect(out).toContain("I/O bound work");
      expect(out).not.toContain("the agent/O");
    });

    it("the reviewer's exact ADR repro produces sane English + no rewritten identifiers", () => {
      const adrProse = "We're moving config to a loader. You'll call `you.method()`; the `we` var is gone. I/O is unchanged, and you've approved it.";
      const state = makeState({
        artifacts: [makeArtifact("research", "Config audit", {
          summary: adrProse,
          findings: [{ category: "Architecture", detail: adrProse, significance: "high" }],
        })],
      });
      const md = formatSessionMarkdown(state, "adr");
      expect(md).not.toMatch(GLUED);
      expect(md).toContain("`you.method()`"); // identifier preserved
      expect(md).toContain("the `we` var is gone"); // inline-code `we` preserved
      expect(md).toContain("I/O is unchanged");
      expect(md).toContain("The pair is moving config");
      expect(md).toContain("the reviewer has approved it");
      expect(md).not.toMatch(/\bYou\b/);
    });

    it("re-capitalizes sentence starts but not after an inline code span mid-sentence", () => {
      const out = neutralizeVoice("You did X. call `foo()` and you continue.");
      expect(out).toContain("The reviewer did X.");
      // The word after the inline span stays lowercase (mid-sentence).
      expect(out).toContain("and the reviewer continue");
    });
  });

  // F2 (#196 Fix 3, review #232) — decisions whose owning artifact was
  // rejected/retracted must not read as shipped in external formats.
  describe("#196 F2 — rejected decisions are gated (via decision.artifactId link)", () => {
    const mkDecision = (over: any = {}) => ({
      decisionId: "d_rej",
      artifactId: "art_dec_rej",
      context: "Where do rate-limit counters live?",
      options: [{ id: "a", title: "Redis", description: "shared" }, { id: "b", title: "In-process", description: "per-node" }],
      response: { optionId: "a", reasoning: "shared store" },
      createdAt: "2026-01-01T00:00:00Z",
      ...over,
    });

    it("pr-description + adr EXCLUDE a decision whose artifact is rejected", () => {
      const state = makeState({
        artifacts: [makeArtifact("decision", "Counter store", {}, "rejected")],
        decisions: [mkDecision()],
      });
      state.artifacts[0]!.id = "art_dec_rej";
      const pr = formatSessionMarkdown(state, "pr-description");
      expect(pr).not.toContain("Where do rate-limit counters live?");
      const adr = formatSessionMarkdown(state, "adr");
      expect(adr).not.toContain("Where do rate-limit counters live?");
    });

    it("full KEEPS the rejected decision but marks it 'Rejected (not built)'", () => {
      const state = makeState({
        artifacts: [makeArtifact("decision", "Counter store", {}, "rejected")],
        decisions: [mkDecision()],
      });
      state.artifacts[0]!.id = "art_dec_rej";
      const full = formatSessionMarkdown(state, "full");
      expect(full).toContain("Where do rate-limit counters live?");
      expect(full).toContain("Rejected (not built)");
    });

    it("a decision with NO resolvable artifact stays ungated (documented gap)", () => {
      // artifactId points at nothing in state → we can't prove rejection.
      const state = makeState({ decisions: [mkDecision({ artifactId: "art_missing" })] });
      const pr = formatSessionMarkdown(state, "pr-description");
      expect(pr).toContain("Where do rate-limit counters live?");
    });
  });
});
