import { describe, it, expect } from "vitest";
import {
  CommentSchema,
  CommentSuggestionSchema,
  CommentBodySchema,
  SuggestionResolveBodySchema,
  suggestionSummary,
  type Comment,
} from "../../index.js";

/**
 * #172 — the suggested-edit object is a first-class, negotiable Comment field.
 * These lock the round-trip, the required shape, and — critically — the
 * backward-compatible degradation: an old daemon that predates the field must
 * treat the comment as a plain comment, never crash.
 */
describe("#172 suggested-edit schema", () => {
  const suggestion = {
    originalText: "  catch { await sleep(1000); }",
    replacementText: "  catch (err) {\n    if (!isRetryable(err)) throw err;\n  }",
    lineStart: 15,
    lineEnd: 17,
    state: "pending" as const,
  };

  it("round-trips a pending suggestion on a comment", () => {
    const comment: Comment = {
      id: "cmt_1",
      sessionId: "s1",
      target: { artifactId: "art_1", lineStart: 15, lineEnd: 17, filePath: "lib/upload.ts" },
      parentCommentId: null,
      author: "human",
      content: "Fixed sleeps hammer the endpoint.",
      intent: "suggestion",
      suggestion,
      acknowledged: false,
      createdAt: new Date().toISOString(),
    };
    const parsed = CommentSchema.parse(comment);
    expect(parsed.suggestion).toEqual(suggestion);
    expect(parsed.intent).toBe("suggestion");
  });

  it("accepts every state and a counter", () => {
    for (const state of ["pending", "applied", "countered", "insisted"] as const) {
      expect(() => CommentSuggestionSchema.parse({ ...suggestion, state })).not.toThrow();
    }
    const countered = CommentSuggestionSchema.parse({
      ...suggestion,
      state: "countered",
      counter: { reason: "returning null drops the upload", replacementText: "throw new Err()" },
    });
    expect(countered.counter?.reason).toMatch(/drops the upload/);
    // appliedInVersion links the version that shipped the edit.
    const applied = CommentSuggestionSchema.parse({ ...suggestion, state: "applied", appliedInVersion: 2 });
    expect(applied.appliedInVersion).toBe(2);
  });

  it("counter.reason is required; replacementText is optional", () => {
    expect(() => CommentSuggestionSchema.parse({ ...suggestion, counter: { reason: "no" } })).not.toThrow();
    expect(() => CommentSuggestionSchema.parse({ ...suggestion, counter: { replacementText: "x" } })).toThrow();
  });

  it("BACKWARD COMPAT — a comment with NO suggestion parses (old data, graceful)", () => {
    const legacy = {
      id: "cmt_old",
      sessionId: "s1",
      target: { artifactId: "art_1" },
      parentCommentId: null,
      author: "human" as const,
      content: "just a plain comment",
      acknowledged: false,
      createdAt: new Date().toISOString(),
    };
    const parsed = CommentSchema.parse(legacy);
    expect(parsed.suggestion).toBeUndefined();
  });

  it("OLD-DAEMON DEGRADATION — a suggestion comment survives a schema that drops the field", () => {
    // Simulate an older CommentSchema that never knew `suggestion` by parsing
    // with a stripping schema: the comment is still valid, just a plain comment.
    const wire = {
      id: "cmt_2",
      sessionId: "s1",
      target: { artifactId: "art_1" },
      parentCommentId: null,
      author: "human" as const,
      content: "please replace this",
      intent: "suggestion" as const,
      suggestion,
      acknowledged: false,
      createdAt: new Date().toISOString(),
    };
    // The intent enum already carried "suggestion" before this feature, so an
    // old daemon accepts intent and simply ignores the unknown `suggestion`
    // object (Zod strips unknown keys by default) — no crash.
    const oldSchema = CommentSchema.omit({ suggestion: true });
    const parsed = oldSchema.parse(wire) as Comment;
    expect(parsed.content).toBe("please replace this");
    expect(parsed.intent).toBe("suggestion");
    expect((parsed as { suggestion?: unknown }).suggestion).toBeUndefined();
  });

  it("CommentBody + SuggestionResolveBody accept the wire shapes", () => {
    const body = CommentBodySchema.parse({
      artifactId: "art_1",
      content: "why",
      target: { lineStart: 15, lineEnd: 17, filePath: "lib/upload.ts" },
      intent: "suggestion",
      suggestion,
    });
    expect(body.suggestion?.state).toBe("pending");
    expect(SuggestionResolveBodySchema.parse({ action: "take_counter" }).action).toBe("take_counter");
    expect(SuggestionResolveBodySchema.parse({ action: "insist" }).action).toBe("insist");
    expect(() => SuggestionResolveBodySchema.parse({ action: "nope" })).toThrow();
  });

  it("suggestionSummary is stable for the composer/ledger 'genuine why' check", () => {
    expect(suggestionSummary("lib/upload.ts", 15, 17)).toBe("Suggested edit to lib/upload.ts:15–17");
    expect(suggestionSummary("lib/upload.ts", 15, 15)).toBe("Suggested edit to lib/upload.ts:15");
    expect(suggestionSummary(undefined, 3, 3)).toBe("Suggested edit to code:3");
  });
});
