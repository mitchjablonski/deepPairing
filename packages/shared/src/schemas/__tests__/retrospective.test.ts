import { describe, it, expect } from "vitest";
import { RetrospectiveSchema, CreateRetrospectiveRequestSchema } from "../../index.js";

describe("RetrospectiveSchema", () => {
  it("accepts a complete retrospective record", () => {
    const r = RetrospectiveSchema.parse({
      id: "retro_1",
      decisionId: "dec_1",
      verdict: "right",
      note: "migration went clean; no downtime.",
      createdAt: "2026-04-20T10:00:00.000Z",
    });
    expect(r.verdict).toBe("right");
  });

  it("accepts verdicts without a note", () => {
    const r = RetrospectiveSchema.parse({
      id: "retro_2",
      decisionId: "dec_2",
      verdict: "wrong",
      createdAt: "2026-04-20T10:00:00.000Z",
    });
    expect(r.note).toBeUndefined();
  });

  it("rejects unknown verdicts", () => {
    expect(() =>
      RetrospectiveSchema.parse({
        id: "x", decisionId: "y", verdict: "ok", createdAt: "2026-04-20T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects non-ISO createdAt", () => {
    expect(() =>
      RetrospectiveSchema.parse({
        id: "x", decisionId: "y", verdict: "right", createdAt: "yesterday",
      }),
    ).toThrow();
  });
});

describe("CreateRetrospectiveRequestSchema", () => {
  it("accepts a minimal create request", () => {
    const r = CreateRetrospectiveRequestSchema.parse({
      decisionId: "dec_1",
      verdict: "mixed",
    });
    expect(r.verdict).toBe("mixed");
  });

  it("caps note length at 2000 chars", () => {
    expect(() =>
      CreateRetrospectiveRequestSchema.parse({
        decisionId: "d", verdict: "right", note: "a".repeat(2001),
      }),
    ).toThrow();
  });
});
