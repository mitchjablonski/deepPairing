import { describe, it, expect } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { buildBriefExceptionIndex, exceptionBucket, summarizeBriefExceptions } from "../briefExceptions";

/**
 * #572 slice A2 — the pure exception index, against Sol's adversarial matrix
 * (#572 comments 6392292748 / 6392364247 as amended by 6406954041) and the two
 * final scope review (6406954041): unknown-grain valid pins count once per
 * lineage in the brief total but never in requirement coverage; buckets are the
 * terminal's exact artifact status (`revised` included), never a resurrected
 * open ancestor.
 */
const now = "2026-10-27T00:00:00.000Z";
function art(over: Record<string, unknown>): Artifact {
  return {
    sessionId: "s1", version: 1, parentId: null, status: "draft", agentReasoning: null,
    createdAt: now, updatedAt: now, title: "t", content: {}, ...over,
  } as unknown as Artifact;
}
const REQS = [{ id: "REQ-1" }, { id: "REQ-2" }, { id: "REQ-3" }, { id: "REQ-3" }, { text: "id-less row" }, { id: "7" }];
const EDGES = [{ id: "wake", path: "p" }, { path: "id-less" }];
const brief = (id: string, over: Record<string, unknown> = {}) =>
  art({ id, type: "spec", title: "Brief", status: "approved", content: { objective: "o", requirements: REQS, edgePaths: EDGES }, ...over });
const card = (id: string, briefRef: unknown, over: Record<string, unknown> = {}) =>
  art({ id, type: "decision", title: `Card ${id}`, content: { context: "c", decisionId: `dec_${id}`, options: [] }, ...(briefRef !== undefined ? { briefRef } : {}), ...over });
const pin = (requirementIds?: string[], edgePathIds?: string[], artifactId = "b1") =>
  ({ artifactId, ...(requirementIds ? { requirementIds } : {}), ...(edgePathIds ? { edgePathIds } : {}) });
const idx = (artifacts: Artifact[], briefId = "b1", sessionId = "s1") => buildBriefExceptionIndex(artifacts, briefId, sessionId);
const ids = (entries: Array<{ decisionId: string }>) => entries.map((e) => e.decisionId);

describe("lineage: the latest decision per lineage counts once", () => {
  it("open ancestor → approved successor → retracted successor is ONE lineage with the terminal status", () => {
    const r = idx([
      brief("b1"),
      card("d1", pin(["REQ-1"]), { status: "superseded" }),
      card("d2", pin(["REQ-1"]), { status: "superseded", parentId: "d1" }),
      card("d3", pin(["REQ-1"]), { status: "retracted", parentId: "d2" }),
    ]);
    expect(r.total).toBe(1);
    expect(ids(r.entries)).toEqual(["d3"]);
    expect(r.buckets.retracted).toBe(1);
    expect(r.buckets.draft + r.buckets.reviewing).toBe(0); // no stale open ancestor resurrected
    expect(ids(r.byRequirement["REQ-1"]!)).toEqual(["d3"]);
  });

  it("an open ancestor is not resurrected when its successor is rejected/obsolete", () => {
    for (const status of ["rejected", "obsolete"]) {
      const r = idx([brief("b1"), card("d1", pin(), { status: "draft" }), card("d2", pin(), { status, parentId: "d1" })]);
      expect(r.total).toBe(1);
      expect(r.buckets.draft).toBe(0);
      expect(r.entries[0]!.bucket).toBe(status);
    }
  });

  it("a tuned card is the same artifact, not a second exception", () => {
    const tuned = card("d1", pin(["REQ-1"]), { status: "draft", updatedAt: "2026-10-27T01:00:00.000Z" });
    expect(idx([brief("b1"), tuned]).total).toBe(1);
  });

  it("identical title/context/decisionId on separate roots stay two lineages", () => {
    const same = { title: "Same", content: { context: "same", decisionId: "dec_same", options: [] } };
    const r = idx([brief("b1"), card("d1", pin(), same), card("d2", pin(), same)]);
    expect(r.total).toBe(2);
  });

  it("a missing parent counts the identified component with incomplete history", () => {
    const r = idx([brief("b1"), card("d2", pin(), { parentId: "gone" })]);
    expect(r.total).toBe(1);
    expect(r.incompleteHistory).toBe(1);
    expect(r.entries[0]!.incompleteHistory).toBe(true);
    expect(summarizeBriefExceptions(r)).toBe("1 linked exception lineage in this view · 1 with incomplete history");
  });

  it("a superseded terminal with no visible successor is incomplete, not open", () => {
    const r = idx([brief("b1"), card("d1", pin(), { status: "superseded" })]);
    expect(r.buckets.incomplete).toBe(1);
    expect(r.buckets.draft + r.buckets.reviewing).toBe(0);
  });

  it("branch, cycle, duplicate id and cross-type parent: excluded from totals, shown as ambiguous with exact members", () => {
    const branch = idx([brief("b1"), card("d1", pin()), card("d2", pin(), { parentId: "d1" }), card("d3", pin(), { parentId: "d1" })]);
    expect(branch.total).toBe(0);
    expect(branch.ambiguous).toEqual([{ memberIds: ["d1", "d2", "d3"], reasons: ["branched lineage"] }]);

    const cycle = idx([brief("b1"), card("d1", pin(), { parentId: "d2" }), card("d2", pin(), { parentId: "d1" })]);
    expect(cycle.total).toBe(0);
    expect(cycle.ambiguous[0]!.reasons).toContain("cyclic lineage");

    const self = idx([brief("b1"), card("d1", pin(), { parentId: "d1" })]);
    expect(self.total).toBe(0);
    expect(self.ambiguous).toHaveLength(1);

    const dup = idx([brief("b1"), card("d1", pin(), { status: "approved" }), card("d1", pin(), { status: "draft" })]);
    expect(dup.total).toBe(0); // no array-first / timestamp winner
    expect(dup.ambiguous[0]!.memberIds).toEqual(["d1", "d1"]);

    const crossType = idx([brief("b1"), art({ id: "p1", type: "plan" }), card("d1", pin(), { parentId: "p1" })]);
    expect(crossType.total).toBe(0);
    expect(crossType.ambiguous[0]!.reasons).toContain("parent p1 is not a decision");
    expect(summarizeBriefExceptions(crossType)).toBe("No linked exception cards in this view · 1 ambiguous lineage group not counted");
  });

  it("an own-id collision with another artifact type excludes the entire component", () => {
    for (const successor of [false, true]) {
      const r = idx([
        brief("b1"),
        art({ id: "x", type: "plan" }),
        ...(successor ? [card("root", pin(), { status: "superseded" })] : []),
        card("x", pin(["REQ-1"]), { parentId: successor ? "root" : null }),
      ]);
      expect(r.total).toBe(0);
      expect(r.entries).toEqual([]);
      expect(r.byRequirement["REQ-1"]).toEqual([]);
      expect(r.ambiguous).toEqual([{
        memberIds: successor ? ["root", "x"] : ["x"],
        reasons: ["duplicate id x"],
      }]);
    }
  });

  it("an ambiguous component whose pins name another brief is not a diagnostic here", () => {
    const r = idx([brief("b1"), brief("b9"), card("d1", pin([], [], "b9")), card("d2", pin([], [], "b9"), { parentId: "d1" }), card("d3", pin([], [], "b9"), { parentId: "d1" })]);
    expect(r.ambiguous).toEqual([]);
  });

  it("a cross-session parent is treated as missing: incomplete, and the foreign record supplies nothing", () => {
    const r = idx([brief("b1"), card("x1", pin(), { sessionId: "s2", title: "Foreign" }), card("d1", pin(), { parentId: "x1" })]);
    expect(r.total).toBe(1);
    expect(r.incompleteHistory).toBe(1);
    expect(JSON.stringify(r)).not.toContain("Foreign");
    expect(JSON.stringify(r)).not.toContain("x1");
  });
});

describe("pins: terminal only, policy-aware, exact brief", () => {
  it("never borrows an ancestor's pin", () => {
    const changed = idx([brief("b1"), brief("b9"), card("d1", pin(["REQ-1"]), { status: "superseded" }), card("d2", pin([], [], "b9"), { parentId: "d1" })]);
    expect(changed.total).toBe(0);
    const dropped = idx([brief("b1"), card("d1", pin(["REQ-1"]), { status: "superseded" }), card("d2", undefined, { parentId: "d1" })]);
    expect(dropped.total).toBe(0);
    expect(dropped.unreadable).toEqual([]);
  });

  it("absent legacy pins are simply unlinked", () => {
    const r = idx([brief("b1"), card("d1", undefined), card("d2", undefined)]);
    expect(r.total).toBe(0);
    expect(r.ambiguous).toEqual([]);
    expect(r.unreadable).toEqual([]);
    expect(summarizeBriefExceptions(r)).toBe("No linked exception cards in this view");
  });

  it("malformed / over-cap / blank / duplicate pins naming this brief are uncounted diagnostics, stored data untouched", () => {
    const bad = [
      { artifactId: "b1", requirementIds: "REQ-1" },
      { artifactId: "b1", requirementIds: Array.from({ length: 9 }, (_, i) => `R${i}`) },
      { artifactId: "b1", requirementIds: [" "] },
      { artifactId: "b1", requirementIds: ["REQ-1", "REQ-1"] },
      { artifactId: "b1", extra: true },
    ];
    const cards = bad.map((b, i) => card(`d${i}`, b));
    const before = JSON.stringify(cards);
    const r = idx([brief("b1"), ...cards]);
    expect(r.total).toBe(0);
    expect(r.unreadable.map((u) => u.decisionId)).toEqual(["d0", "d1", "d2", "d3", "d4"]);
    expect(JSON.stringify(cards)).toBe(before);
    expect(summarizeBriefExceptions(r)).toBe("No linked exception cards in this view · 5 unreadable links not counted");
  });

  it("unrelated invalid refs do not pollute this brief", () => {
    const r = idx([brief("b1"), card("d1", { artifactId: "b9", requirementIds: "x" }), card("d2", 42)]);
    expect(r.unreadable).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("a pin to an unavailable brief is never counted here", () => {
    const r = idx([brief("b1"), card("d1", pin(["REQ-1"], undefined, "b_missing"))]);
    expect(r.total).toBe(0);
  });
});

describe("requirement attribution (exact raw explicit ids)", () => {
  it("a card naming two requirements: one brief total, once in each list", () => {
    const r = idx([brief("b1"), card("d1", pin(["REQ-1", "REQ-2"]))]);
    expect(r.total).toBe(1);
    expect(ids(r.byRequirement["REQ-1"]!)).toEqual(["d1"]);
    expect(ids(r.byRequirement["REQ-2"]!)).toEqual(["d1"]);
  });

  it("whole-brief and edge-path-only pins are not requirement-specific", () => {
    const r = idx([brief("b1"), card("d1", pin()), card("d2", pin(undefined, ["wake"]))]);
    expect(ids(r.briefLevel)).toEqual(["d1", "d2"]);
    expect(Object.values(r.byRequirement).flat()).toEqual([]);
  });

  it("unknown / ambiguous grains count once in the total but are unattributed, never under a row", () => {
    const r = idx([
      brief("b1"),
      card("unknown", pin(["REQ-9"])),
      card("dupe", pin(["REQ-3"])), // REQ-3 is duplicated on the spec
      card("idless", pin(["4"])), // position 4 is the id-less row; no index fallback
      card("edge", pin(undefined, ["2"])),
      card("mixed", pin(["REQ-1", "REQ-9"])),
    ]);
    expect(r.total).toBe(5);
    expect(r.requirementIds).toEqual(["REQ-1", "REQ-2", "7"]); // unique explicit only
    expect(r.byRequirement["REQ-3"]).toBeUndefined();
    expect(ids(r.byRequirement["REQ-1"]!)).toEqual(["mixed"]);
    expect(r.unattributed.map((u) => [u.entry.decisionId, u.grains.map((g) => `${g.id}:${g.match}`)])).toEqual([
      ["unknown", ["REQ-9:unknown"]],
      ["dupe", ["REQ-3:ambiguous"]],
      ["idless", ["4:unknown"]],
      ["edge", ["2:unknown"]],
      ["mixed", ["REQ-9:unknown"]],
    ]);
  });

  it("a unique legacy explicit id \"7\" matches exactly", () => {
    const r = idx([brief("b1"), card("d1", pin(["7"]))]);
    expect(ids(r.byRequirement["7"]!)).toEqual(["d1"]);
  });
});

describe("versions: historical groups, never retargeted", () => {
  const v1 = brief("b1", { status: "superseded" });
  const v2 = brief("b2", { parentId: "b1", version: 2 });

  it("a v1 pin viewed on v2 is historical, labelled v1, keyed by the exact pinned id, not on v2's REQ-1 row", () => {
    const r = idx([v1, v2, card("d1", pin(["REQ-1"]))], "b2");
    expect(r.total).toBe(1);
    expect(r.byRequirement["REQ-1"]).toEqual([]);
    expect(r.historical).toHaveLength(1);
    expect(r.historical[0]!.pinnedBriefId).toBe("b1");
    expect(r.historical[0]!.pinnedVersion).toBe(1);
    expect(r.historical[0]!.key).toBe("b1\u0000requirement:REQ-1");
    expect(r.entries[0]!.historical).toBe(true);
  });

  it("two historical pins with the same version number on different artifacts stay separate groups", () => {
    const a = brief("bA", { status: "superseded" });
    const b = brief("bB", { status: "superseded", parentId: "bA" }); // also v1 (bad data)
    const c = brief("bC", { parentId: "bB", version: 3 });
    const r = idx([a, b, c, card("d1", pin([], [], "bA")), card("d2", pin([], [], "bB"))], "bC");
    expect(r.historical.map((g) => g.key)).toEqual(["bA\u0000whole", "bB\u0000whole"]);
  });

  it("a descendant or sibling pin is not counted on the viewed brief", () => {
    const sibling = brief("b3", { parentId: "b1", version: 2 });
    const r1 = idx([v1, v2, sibling, card("d1", pin([], [], "b2"))], "b1");
    expect(r1.total).toBe(0); // descendant
    const r3 = idx([v1, v2, sibling, card("d1", pin([], [], "b2"))], "b3");
    expect(r3.total).toBe(0); // sibling
  });

  it("cyclic spec ancestry establishes no historical membership", () => {
    const x = brief("bx", { parentId: "by" });
    const y = brief("by", { parentId: "bx", version: 2 });
    const r = idx([x, y, card("d1", pin([], [], "bx"))], "by");
    expect(r.total).toBe(0);
  });

  it("incomplete or ambiguous spec ancestry grants no historical membership, even for a visible prefix", () => {
    const invalidAncestors = [
      [], // missing b1
      [brief("b1"), brief("b1")],
      [art({ id: "b1", type: "plan" })],
      [brief("b1"), art({ id: "b1", type: "plan" })],
    ];
    for (const ancestors of invalidAncestors) {
      const r = idx([
        ...ancestors,
        brief("b2", { parentId: "b1", version: 2 }),
        brief("b3", { parentId: "b2", version: 3 }),
        card("historical", pin(["REQ-1"], undefined, "b2")),
        card("exact", pin(["REQ-1"], undefined, "b3")),
      ], "b3");
      expect(r.total).toBe(1);
      expect(ids(r.entries)).toEqual(["exact"]);
      expect(r.historical).toEqual([]);
      expect(ids(r.byRequirement["REQ-1"]!)).toEqual(["exact"]);
    }
  });

  it("a brief whose id is duplicated in its session attributes nothing", () => {
    const r = idx([brief("b1"), brief("b1"), card("d1", pin())]);
    expect(r.briefIdAmbiguous).toBe(true);
    expect(r.total).toBe(0);
    expect(summarizeBriefExceptions(r)).not.toMatch(/^No linked/);
  });
});

describe("session isolation", () => {
  it("cards and briefs with the same ids in another session are excluded", () => {
    const r = idx([
      brief("b1"),
      brief("b1", { sessionId: "s2" }),
      card("d1", pin(["REQ-1"])),
      card("d9", pin(["REQ-1"]), { sessionId: "s2" }),
    ]);
    expect(r.briefIdAmbiguous).toBe(false);
    expect(ids(r.entries)).toEqual(["d1"]);
    const other = idx([brief("b1", { sessionId: "s2" }), card("d9", pin(["REQ-1"]), { sessionId: "s2" }), card("d1", pin(["REQ-1"]))], "b1", "s2");
    expect(ids(other.entries)).toEqual(["d9"]);
  });
});

describe("status buckets (artifact status only)", () => {
  it("draft, reviewing, approved, rejected, retracted, obsolete, incomplete and exact other statuses are distinct", () => {
    expect(exceptionBucket("draft")).toBe("draft");
    expect(exceptionBucket("reviewing")).toBe("reviewing");
    expect(exceptionBucket("revised")).toBe("other"); // shown as its exact status
    expect(exceptionBucket("approved")).toBe("approved");
    expect(exceptionBucket("rejected")).toBe("rejected");
    expect(exceptionBucket("retracted")).toBe("retracted");
    expect(exceptionBucket("obsolete")).toBe("obsolete");
    expect(exceptionBucket("superseded")).toBe("incomplete");
    expect(exceptionBucket("weird")).toBe("other");
    const statuses = ["draft", "reviewing", "revised", "approved", "rejected", "retracted", "obsolete", "weird"];
    const r = idx([brief("b1"), ...statuses.map((status, i) => card(`d${i}`, pin(["REQ-1"]), { status }))]);
    expect(r.total).toBe(8);
    expect(r.buckets).toEqual({ draft: 1, reviewing: 1, approved: 1, rejected: 1, retracted: 1, obsolete: 1, incomplete: 0, other: 2 });
    expect(r.otherStatuses).toEqual({ revised: 1, weird: 1 });
  });

  it("a revised terminal keeps its own status; its draft ancestor is never resurrected", () => {
    const r = idx([brief("b1"), card("d1", pin(), { status: "superseded" }), card("d2", pin(), { status: "revised", parentId: "d1" })]);
    expect(r.total).toBe(1);
    expect(r.entries[0]!.status).toBe("revised");
    expect(r.buckets.draft + r.buckets.reviewing).toBe(0);
  });

  it("the derivation never mutates its input", () => {
    const deepFreeze = <T,>(o: T): T => {
      if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
      return o;
    };
    const input = deepFreeze([brief("b1"), card("d1", pin(["REQ-1"])), card("d2", pin(), { parentId: "d1" })]);
    expect(() => idx(input)).not.toThrow();
  });
});
