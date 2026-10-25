import { describe, it, expect } from "vitest";
import {
  ArtifactSchema,
  BriefRefSchema,
  ProposalSnapshotSchema,
  briefRefProblems,
  describeBriefPin,
  formatBriefPin,
  matchBriefGrain,
  readBriefRef,
  MAX_SPEC_ID_LENGTH,
} from "../../index.js";

/**
 * #572 slice A — the pure brief-ref policy: new-ref caps (whole ref or
 * nothing), read-tolerant persisted refs, and exact explicit-id grain lookup.
 */
const now = "2026-10-24T00:00:00.000Z";
const ascii = (n: number) => "a".repeat(n);
const astral = (n: number) => "😀".repeat(n); // 2 UTF-16 code units each

describe("briefRefProblems — new-ref caps (8 ids, 64 UTF-16 units, non-blank, unique)", () => {
  it("accepts a well-formed ref, with or without grain lists", () => {
    expect(briefRefProblems({ artifactId: "art_x" })).toEqual([]);
    expect(briefRefProblems({ artifactId: "art_x", requirementIds: ["REQ-1"], edgePathIds: ["wake"] })).toEqual([]);
  });

  it("64/65 ASCII and 32/33 astral characters: accept / reject (code units, as #589 counts)", () => {
    expect(MAX_SPEC_ID_LENGTH).toBe(64);
    expect(briefRefProblems({ artifactId: "art_x", requirementIds: [ascii(64)] })).toEqual([]);
    expect(briefRefProblems({ artifactId: "art_x", requirementIds: [ascii(65)] })).toHaveLength(1);
    expect(briefRefProblems({ artifactId: "art_x", edgePathIds: [astral(32)] })).toEqual([]);
    expect(briefRefProblems({ artifactId: "art_x", edgePathIds: [astral(33)] })).toHaveLength(1);
    expect(briefRefProblems({ artifactId: ascii(64) })).toEqual([]);
    expect(briefRefProblems({ artifactId: ascii(65) })).toHaveLength(1);
    expect(briefRefProblems({ artifactId: astral(33) })).toHaveLength(1);
  });

  it("8 ids per list pass, 9 fail (never truncated to 8)", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `REQ-${i}`);
    expect(briefRefProblems({ artifactId: "art_x", requirementIds: ids(8), edgePathIds: ids(8) })).toEqual([]);
    expect(briefRefProblems({ artifactId: "art_x", requirementIds: ids(9) })).not.toEqual([]);
    expect(briefRefProblems({ artifactId: "art_x", edgePathIds: ids(9) })).not.toEqual([]);
  });

  it("blank, duplicate, non-string, unknown-key and non-object refs all fail", () => {
    for (const bad of [
      null, "art_x", ["art_x"], 7,
      {},
      { artifactId: "" },
      { artifactId: "   " },
      { artifactId: 12 },
      { artifactId: "art_x", requirementIds: ["  "] },
      { artifactId: "art_x", requirementIds: ["REQ-1", "REQ-1"] },
      { artifactId: "art_x", requirementIds: "REQ-1" },
      { artifactId: "art_x", edgePathIds: [3] },
      { artifactId: "art_x", version: 2 },
    ]) {
      expect(briefRefProblems(bad), JSON.stringify(bad)).not.toEqual([]);
    }
  });

  it("does not trim or case-fold: ' REQ-1' and 'req-1' are distinct, valid ids", () => {
    expect(briefRefProblems({ artifactId: "art_x", requirementIds: ["REQ-1", " REQ-1", "req-1"] })).toEqual([]);
  });
});

describe("persisted refs load tolerantly", () => {
  const base = {
    id: "art_d", sessionId: "s1", type: "decision", version: 1, parentId: null, title: "t", status: "draft",
    content: {}, agentReasoning: null, createdAt: now, updatedAt: now,
  };

  it("an artifact with a malformed or oversized stored ref still parses; readBriefRef marks it", () => {
    for (const briefRef of [{ artifactId: 3 }, "art_x", { artifactId: "art_x", requirementIds: "REQ-1" }]) {
      expect(ArtifactSchema.safeParse({ ...base, briefRef }).success).toBe(true);
      expect(readBriefRef(briefRef)?.ok).toBe(false);
    }
    expect(readBriefRef({ artifactId: "art_x", requirementIds: "REQ-1" })).toEqual({ ok: false, rawId: "art_x" });
    expect(readBriefRef(undefined)).toBeUndefined();
  });

  it("a shape-valid but out-of-policy stored ref loads unchanged yet classifies as unavailable", () => {
    for (const briefRef of [
      { artifactId: "art_b1", requirementIds: ["REQ-1", "REQ-1"] },
      { artifactId: "art_b1", requirementIds: Array.from({ length: 9 }, (_, i) => `R${i}`) },
      { artifactId: "art_b1", edgePathIds: ["a".repeat(65)] },
      { artifactId: "art_b1", requirementIds: ["  "] },
      { artifactId: "   " },
      { artifactId: "x".repeat(65) },
    ]) {
      const before = JSON.stringify(briefRef);
      const parsed = ArtifactSchema.safeParse({ ...base, briefRef });
      expect(parsed.success).toBe(true);
      expect(JSON.stringify((parsed as { data: { briefRef: unknown } }).data.briefRef)).toBe(before);
      expect(readBriefRef(briefRef)?.ok, before).toBe(false);
      expect(JSON.stringify(briefRef)).toBe(before);
    }
    expect(readBriefRef({ artifactId: "art_b1", requirementIds: ["REQ-1", "REQ-1"] })).toEqual({ ok: false, rawId: "art_b1" });
    // In policy: a resolved pin.
    expect(readBriefRef({ artifactId: "art_b1", requirementIds: ["REQ-1"] })).toEqual({ ok: true, ref: { artifactId: "art_b1", requirementIds: ["REQ-1"] } });
  });

  it("an artifact with no ref still parses", () => {
    expect(ArtifactSchema.safeParse(base).success).toBe(true);
  });

  it("the strict proposal snapshot accepts a ref and still refuses unknown keys", () => {
    const snap = { kind: "create", type: "decision", title: "t", content: {} };
    expect(ProposalSnapshotSchema.safeParse({ ...snap, briefRef: { artifactId: "art_x", requirementIds: ["REQ-1"] } }).success).toBe(true);
    expect(ProposalSnapshotSchema.safeParse({ ...snap, briefRef: { artifactId: "art_x", extra: 1 } }).success).toBe(false);
    expect(ProposalSnapshotSchema.safeParse({ ...snap, briefRefs: [] }).success).toBe(false);
    expect(BriefRefSchema.safeParse({ artifactId: "art_x" }).success).toBe(true);
  });
});

describe("matchBriefGrain — exact explicit ids within the pinned version", () => {
  const rows = [{ path: "id-less 0" }, { path: "id-less 1" }, { path: "id-less 2" }, { id: "7", path: "legacy numeric" }, { id: "dup" }, { id: "dup" }];

  it("an id-less row at index 2 never matches '2'", () => {
    expect(matchBriefGrain(rows, "2")).toBe("unknown");
  });
  it("a unique legacy numeric explicit id matches exactly", () => {
    expect(matchBriefGrain(rows, "7")).toBe("known");
  });
  it("a legacy duplicate is ambiguous, never first-match", () => {
    expect(matchBriefGrain(rows, "dup")).toBe("ambiguous");
  });
  it("no trim, no case-fold", () => {
    expect(matchBriefGrain([{ id: "REQ-1" }], " REQ-1")).toBe("unknown");
    expect(matchBriefGrain([{ id: "REQ-1" }], "req-1")).toBe("unknown");
    expect(matchBriefGrain(undefined, "REQ-1")).toBe("unknown");
  });
});

describe("describeBriefPin / formatBriefPin — the exact pin, same session, no successor", () => {
  const spec = (over: Record<string, unknown> = {}) => ({
    id: "art_b1", sessionId: "s1", type: "spec", title: "Auth brief", version: 1, status: "draft",
    content: { requirements: [{ id: "REQ-1" }, { id: "REQ-2" }, { id: "REQ-2" }], edgePaths: [{ id: "wake" }] }, ...over,
  });
  const ref = { artifactId: "art_b1", requirementIds: ["REQ-1", "REQ-2", "REQ-9"], edgePathIds: ["wake"] };

  it("labels grains and the version", () => {
    expect(formatBriefPin(describeBriefPin(ref, [spec()], "s1")))
      .toBe('Exception to "Auth brief" v1 · REQ-1, REQ-2 (ambiguous), REQ-9 (unknown), edge path wake');
  });

  it("a closed pinned version keeps its pin and says so; a successor is never used", () => {
    const v2 = spec({ id: "art_b2", version: 2 });
    for (const status of ["superseded", "rejected", "retracted", "obsolete"]) {
      const view = describeBriefPin({ artifactId: "art_b1" }, [spec({ status }), v2], "s1");
      expect(view).toMatchObject({ artifactId: "art_b1", available: true, version: 1, closed: true, status });
      expect(formatBriefPin(view)).toBe(`Exception to "Auth brief" v1 (${status})`);
    }
  });

  it("another session's artifact, a non-spec, or a missing id is unavailable: version unknown", () => {
    for (const arts of [[spec({ sessionId: "s2" })], [spec({ type: "plan" })], []]) {
      const view = describeBriefPin(ref, arts, "s1");
      expect(view.available).toBe(false);
      expect(view.version).toBeUndefined();
      expect(view.grains.every((g) => g.match === undefined)).toBe(true);
      expect(formatBriefPin(view)).toContain("Exception to brief art_b1 (version unknown, brief unavailable)");
    }
  });
});
