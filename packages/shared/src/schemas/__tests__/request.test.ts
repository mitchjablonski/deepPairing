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

  /**
   * P2 review F1/F2/F6 — a diff has two coordinate systems and only the new-side
   * one matches the working tree. The rendered clause must never let an old-side
   * range pass as something the agent can open on disk.
   */
  it("F1 — an OLD-side range renders with the lines-are-gone warning", () => {
    const s = describeRequestScope({ filePath: "a.ts", lineStart: 8, lineEnd: 9, side: "old" });
    expect(s).toContain("a.ts:8-9");
    expect(s).toMatch(/PRE-change lines/);
    expect(s).toMatch(/no longer exist in the working tree/);
    expect(s).toMatch(/read them from the changeset diff/);
  });

  it("F1 — a DELETED file says the path itself is gone", () => {
    const s = describeRequestScope({ filePath: "a.ts", lineStart: 8, lineEnd: 9, side: "old", fileRemoved: true });
    expect(s).toMatch(/this file was DELETED in this changeset/);
  });

  it("F2 — a mixed hunk names the removed lines that fall outside the new-side range", () => {
    const s = describeRequestScope({
      filePath: "a.ts", lineStart: 10, lineEnd: 11, side: "new", oldStart: 11, oldEnd: 14, removedLineCount: 4,
    });
    expect(s).toContain("a.ts:10-11");
    expect(s).toContain("plus 4 lines removed (pre-change 11-14)");
    // The new-side range carries no pre-change warning — it IS the working tree.
    expect(s).not.toMatch(/no longer exist/);
  });

  it("F1 — a plain new-side range stays exactly as before (no added noise)", () => {
    expect(describeRequestScope({ filePath: "a.ts", lineStart: 4, lineEnd: 6, side: "new" })).toBe("a.ts:4-6");
  });

  it("F6 — the artifact the ask was FLAGGED IN rides beside the one it points at", () => {
    expect(
      describeRequestScope({ artifactId: "cs_1", sourceArtifactId: "debrief_1", itemRef: "debrief:needs-your-eyes:2" }),
    ).toBe("artifact cs_1 (flagged in debrief_1) · debrief:needs-your-eyes:2");
    // Source alone (no target) still names an artifact rather than dropping it.
    expect(describeRequestScope({ sourceArtifactId: "debrief_1" })).toBe("artifact debrief_1");
  });

  it("describeRequestIntent names the fulfilling tool per intent", () => {
    expect(describeRequestIntent("explain")).toMatch(/present_explainer/);
    expect(describeRequestIntent("plan")).toMatch(/present_plan/);
    expect(describeRequestIntent("status")).toMatch(/present_debrief/);
  });
});
