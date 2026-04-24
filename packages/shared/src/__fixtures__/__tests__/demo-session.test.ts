/**
 * R5 — lock the canonical pairing fixture's shape. Hand-checked that the
 * transcript reads as a coherent 10-minute session; tests guard the
 * invariants the UI depends on (timestamps monotonic, artifacts covering
 * every type, question + answer linked, decision record prediction
 * captured).
 */
import { describe, it, expect } from "vitest";
import { demoArtifacts, demoComments, demoDecisionRecords } from "../demo-session.js";

describe("demo-session fixture", () => {
  it("covers every artifact type the UI renders", () => {
    const types = new Set(demoArtifacts.map((a) => a.type));
    expect(types).toContain("research");
    expect(types).toContain("spec");
    expect(types).toContain("decision");
    expect(types).toContain("plan");
    expect(types).toContain("reasoning");
    expect(types).toContain("code_change");
  });

  it("timestamps are monotonically non-decreasing (reads as one session)", () => {
    const stamps = demoArtifacts.map((a) => a.createdAt);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i] >= stamps[i - 1]).toBe(true);
    }
  });

  it("includes a high-stakes decision with stakes: 'high'", () => {
    const highStakes = demoArtifacts.find(
      (a) => a.type === "decision" && (a.content as any)?.stakes === "high",
    );
    expect(highStakes).toBeDefined();
  });

  it("includes a reasoning artifact with a named concept + one-line explanation", () => {
    const named = demoArtifacts.find(
      (a) => a.type === "reasoning" && (a.content as any)?.concept?.name,
    );
    expect(named).toBeDefined();
    expect((named!.content as any).concept.oneLineExplanation.length).toBeGreaterThan(0);
  });

  it("has a question comment linked to an agent answer via parentCommentId + answeredByCommentId", () => {
    const question = demoComments.find((c) => c.intent === "question");
    expect(question).toBeDefined();
    expect(question!.answeredByCommentId).toBeDefined();
    const answer = demoComments.find((c) => c.id === question!.answeredByCommentId);
    expect(answer).toBeDefined();
    expect(answer!.author).toBe("agent");
    expect(answer!.parentCommentId).toBe(question!.id);
  });

  it("exports a decision record with predictedOutcome + confidence (for the predictions breadcrumb)", () => {
    expect(demoDecisionRecords).toHaveLength(1);
    const rec = demoDecisionRecords[0];
    expect(rec.response.predictedOutcome).toMatch(/migration/i);
    expect(rec.response.confidence).toBe("medium");
    expect(rec.decisionId).toBe("dec_hashing");
  });
});
