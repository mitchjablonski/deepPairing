/**
 * U2 — request-body schema contracts. Pin the shape every public route
 * accepts so a frontend or test that drifts from it gets a clear 400
 * with a structured error code instead of crashing deeper in the
 * handler with a "cannot read property 'foo' of undefined" stack trace.
 */
import { describe, it, expect } from "vitest";
import {
  CommentBodySchema,
  DecisionResolveBodySchema,
  StatusUpdateBodySchema,
  RenameBodySchema,
  PreferenceBodySchema,
  RetrospectiveBodySchema,
  PromptBodySchema,
  formatZodIssues,
} from "../request-bodies.js";

describe("CommentBodySchema", () => {
  it("requires non-empty artifactId and content", () => {
    expect(CommentBodySchema.safeParse({ artifactId: "", content: "hi" }).success).toBe(false);
    expect(CommentBodySchema.safeParse({ artifactId: "a", content: "" }).success).toBe(false);
    expect(CommentBodySchema.safeParse({ artifactId: "a", content: "hi" }).success).toBe(true);
  });

  it("accepts optional intent / target / parentCommentId", () => {
    const r = CommentBodySchema.safeParse({
      artifactId: "a", content: "hi",
      intent: "question",
      target: { line: 12 },
      parentCommentId: "c0",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown intent value", () => {
    const r = CommentBodySchema.safeParse({ artifactId: "a", content: "hi", intent: "scream" });
    expect(r.success).toBe(false);
  });
});

describe("StatusUpdateBodySchema", () => {
  it("only accepts approved | revised | rejected", () => {
    expect(StatusUpdateBodySchema.safeParse({ status: "approved" }).success).toBe(true);
    expect(StatusUpdateBodySchema.safeParse({ status: "draft" }).success).toBe(false);
    expect(StatusUpdateBodySchema.safeParse({ status: "" }).success).toBe(false);
    expect(StatusUpdateBodySchema.safeParse({}).success).toBe(false);
  });

  it("optional feedback string passes through", () => {
    const r = StatusUpdateBodySchema.safeParse({ status: "rejected", feedback: "needs work" });
    expect(r.success && r.data.feedback).toBe("needs work");
  });
});

describe("DecisionResolveBodySchema", () => {
  it("requires non-empty optionId", () => {
    expect(DecisionResolveBodySchema.safeParse({ optionId: "" }).success).toBe(false);
    expect(DecisionResolveBodySchema.safeParse({ optionId: "a" }).success).toBe(true);
  });

  it("accepts the prediction-capture fields when present", () => {
    const r = DecisionResolveBodySchema.safeParse({
      optionId: "opt_x",
      reasoning: "best fit",
      confidence: "high",
      predictedOutcome: "Will hold for 3+ months",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown confidence value", () => {
    expect(DecisionResolveBodySchema.safeParse({ optionId: "a", confidence: "absolute" }).success).toBe(false);
  });
});

describe("RenameBodySchema", () => {
  it("rejects empty / missing title", () => {
    expect(RenameBodySchema.safeParse({}).success).toBe(false);
    expect(RenameBodySchema.safeParse({ title: "" }).success).toBe(false);
    expect(RenameBodySchema.safeParse({ title: "New" }).success).toBe(true);
  });
});

describe("PreferenceBodySchema", () => {
  it("autonomyLevel is optional but constrained when present", () => {
    expect(PreferenceBodySchema.safeParse({}).success).toBe(true);
    expect(PreferenceBodySchema.safeParse({ autonomyLevel: "balanced" }).success).toBe(true);
    expect(PreferenceBodySchema.safeParse({ autonomyLevel: "yolo" }).success).toBe(false);
  });
});

describe("RetrospectiveBodySchema", () => {
  it("requires decisionId AND verdict in the closed enum", () => {
    expect(RetrospectiveBodySchema.safeParse({ decisionId: "", verdict: "right" }).success).toBe(false);
    expect(RetrospectiveBodySchema.safeParse({ decisionId: "d", verdict: "ok" }).success).toBe(false);
    expect(RetrospectiveBodySchema.safeParse({ decisionId: "d", verdict: "right" }).success).toBe(true);
  });

  it("caps note length at 2000 chars", () => {
    expect(RetrospectiveBodySchema.safeParse({ decisionId: "d", verdict: "right", note: "x".repeat(2001) }).success).toBe(false);
    expect(RetrospectiveBodySchema.safeParse({ decisionId: "d", verdict: "right", note: "x".repeat(2000) }).success).toBe(true);
  });
});

describe("PromptBodySchema", () => {
  it("requires content + decisionId + sessionId all non-empty", () => {
    expect(PromptBodySchema.safeParse({ content: "x", decisionId: "d" }).success).toBe(false);
    expect(PromptBodySchema.safeParse({ content: "x", decisionId: "d", sessionId: "" }).success).toBe(false);
    expect(PromptBodySchema.safeParse({ content: "x", decisionId: "d", sessionId: "s" }).success).toBe(true);
  });
});

describe("formatZodIssues", () => {
  it("produces a payload with code='validation_error' and a human summary", () => {
    const r = StatusUpdateBodySchema.safeParse({ status: "draft" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const out = formatZodIssues(r.error);
      expect(out.code).toBe("validation_error");
      expect(out.error).toMatch(/status/);
      expect(out.issues).toHaveLength(1);
      expect(out.issues[0]!.path).toBe("status");
    }
  });

  it("summarizes 'first of N' when multiple issues exist", () => {
    const r = CommentBodySchema.safeParse({ artifactId: "", content: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const out = formatZodIssues(r.error);
      expect(out.error).toMatch(/2 validation errors/);
    }
  });
});
