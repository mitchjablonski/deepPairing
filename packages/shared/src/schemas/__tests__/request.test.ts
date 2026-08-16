import { describe, it, expect } from "vitest";
import { RequestSchema, RequestIntentSchema, describeRequestIntent, describeRequestScope } from "../request.js";
import { CreateRequestBodySchema } from "../request-bodies.js";

describe("G1 (#198b) Request schema", () => {
  it("accepts a well-formed request", () => {
    const r = RequestSchema.parse({
      id: "req_abc",
      text: "the auth middleware",
      intent: "explain",
      createdAt: "2026-08-04T00:00:00.000Z",
    });
    expect(r.servedByArtifactId).toBeUndefined();
  });

  it("carries an optional servedByArtifactId (back-compat: absent loads unchanged)", () => {
    const r = RequestSchema.parse({
      id: "req_abc",
      text: "x",
      intent: "plan",
      createdAt: "2026-08-04T00:00:00.000Z",
      servedByArtifactId: "art_1",
    });
    expect(r.servedByArtifactId).toBe("art_1");
  });

  it("#204 carries optional secretWarnings (back-compat: absent loads unchanged)", () => {
    // Absent — an old stored request parses clean.
    const clean = RequestSchema.parse({
      id: "req_abc",
      text: "the auth middleware",
      intent: "explain",
      createdAt: "2026-08-04T00:00:00.000Z",
    });
    expect(clean.secretWarnings).toBeUndefined();
    // Present — labels/pattern/line only (the shape addRequest stamps).
    const flagged = RequestSchema.parse({
      id: "req_hot",
      text: "x",
      intent: "status",
      createdAt: "2026-08-04T00:00:00.000Z",
      secretWarnings: [{ pattern: "AKIA", label: "AWS access key id", line: 1 }],
    });
    expect(flagged.secretWarnings).toHaveLength(1);
    expect(flagged.secretWarnings![0]!.label).toBe("AWS access key id");
  });

  it("enforces the three intent presets", () => {
    expect(RequestIntentSchema.options).toEqual(["explain", "plan", "status"]);
    expect(RequestSchema.safeParse({ id: "r", text: "x", intent: "wat", createdAt: "2026-08-04T00:00:00.000Z" }).success).toBe(false);
  });

  it("CreateRequestBodySchema requires non-empty text + a valid intent", () => {
    expect(CreateRequestBodySchema.safeParse({ text: "", intent: "explain" }).success).toBe(false);
    expect(CreateRequestBodySchema.safeParse({ text: "x", intent: "nope" }).success).toBe(false);
    expect(CreateRequestBodySchema.safeParse({ text: "x", intent: "status" }).success).toBe(true);
  });

  /**
   * P2 (round-11 MED 3) — scope as DATA. Both fields are OPTIONAL: a pre-P2
   * stored request parses unchanged, and a walk-me-through request carries the
   * exact file/lines/artifact the explainer must be scoped to.
   */
  it("P2 carries optional source + scope (back-compat: absent loads unchanged)", () => {
    const legacy = RequestSchema.parse({
      id: "req_old", text: "x", intent: "explain", createdAt: "2026-08-04T00:00:00.000Z",
    });
    expect(legacy.source).toBeUndefined();
    expect(legacy.scope).toBeUndefined();

    const scoped = RequestSchema.parse({
      id: "req_new", text: "x", intent: "explain", createdAt: "2026-08-15T00:00:00.000Z",
      source: "walk_me_through",
      scope: { artifactId: "art_cs", filePath: "auth/middleware.ts", lineStart: 25, lineEnd: 27 },
    });
    expect(scoped.source).toBe("walk_me_through");
    expect(scoped.scope!.lineEnd).toBe(27);

    // A bogus source / non-positive line is rejected at the boundary.
    expect(RequestSchema.safeParse({ id: "r", text: "x", intent: "explain", createdAt: "2026-08-15T00:00:00.000Z", source: "telepathy" }).success).toBe(false);
    expect(RequestSchema.safeParse({ id: "r", text: "x", intent: "explain", createdAt: "2026-08-15T00:00:00.000Z", scope: { lineStart: 0 } }).success).toBe(false);
  });

  it("P2 CreateRequestBodySchema accepts source + scope, and still accepts neither", () => {
    expect(CreateRequestBodySchema.safeParse({ text: "x", intent: "explain" }).success).toBe(true);
    expect(CreateRequestBodySchema.safeParse({
      text: "x", intent: "explain", source: "composer", scope: { filePath: "a.ts" },
    }).success).toBe(true);
    expect(CreateRequestBodySchema.safeParse({ text: "x", intent: "explain", source: "nope" }).success).toBe(false);
  });

  it("describeRequestScope renders one compact clause (and nothing for an unscoped request)", () => {
    expect(describeRequestScope(undefined)).toBe("");
    expect(describeRequestScope({})).toBe("");
    expect(describeRequestScope({ filePath: "a.ts" })).toBe("a.ts");
    expect(describeRequestScope({ filePath: "a.ts", lineStart: 5, lineEnd: 9 })).toBe("a.ts:5-9");
    // A one-line range doesn't render a redundant "5-5".
    expect(describeRequestScope({ filePath: "a.ts", lineStart: 5, lineEnd: 5 })).toBe("a.ts:5");
    expect(describeRequestScope({ artifactId: "art_1", itemRef: "debrief:needs-your-eyes:0" })).toBe(
      "artifact art_1 · debrief:needs-your-eyes:0",
    );
  });

  it("describeRequestIntent names the fulfilling tool per intent", () => {
    expect(describeRequestIntent("explain")).toMatch(/present_explainer/);
    expect(describeRequestIntent("plan")).toMatch(/present_plan/);
    expect(describeRequestIntent("status")).toMatch(/present_debrief/);
  });
});
