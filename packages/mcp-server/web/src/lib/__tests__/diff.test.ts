import { describe, it, expect } from "vitest";
import { computeLineDiff, collapseDiff } from "../diff";

describe("computeLineDiff", () => {
  it("returns empty array for two empty strings", () => {
    expect(computeLineDiff("", "")).toEqual([
      { type: "unchanged", content: "", oldLineNum: 1, newLineNum: 1 },
    ]);
  });

  it("returns all unchanged for identical strings", () => {
    const result = computeLineDiff("a\nb\nc", "a\nb\nc");
    expect(result).toEqual([
      { type: "unchanged", content: "a", oldLineNum: 1, newLineNum: 1 },
      { type: "unchanged", content: "b", oldLineNum: 2, newLineNum: 2 },
      { type: "unchanged", content: "c", oldLineNum: 3, newLineNum: 3 },
    ]);
  });

  it("detects a single line addition", () => {
    const result = computeLineDiff("a\nc", "a\nb\nc");
    const added = result.filter((l) => l.type === "added");
    expect(added).toHaveLength(1);
    expect(added[0].content).toBe("b");
  });

  it("detects a single line removal", () => {
    const result = computeLineDiff("a\nb\nc", "a\nc");
    const removed = result.filter((l) => l.type === "removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].content).toBe("b");
  });

  it("handles mixed additions and removals", () => {
    const result = computeLineDiff("a\nb\nc", "a\nx\nc");
    expect(result.some((l) => l.type === "removed" && l.content === "b")).toBe(true);
    expect(result.some((l) => l.type === "added" && l.content === "x")).toBe(true);
    expect(result.filter((l) => l.type === "unchanged")).toHaveLength(2);
  });

  it("assigns correct line numbers", () => {
    const result = computeLineDiff("old", "new");
    const removed = result.find((l) => l.type === "removed");
    const added = result.find((l) => l.type === "added");
    expect(removed?.oldLineNum).toBe(1);
    expect(added?.newLineNum).toBe(1);
  });

  it("handles complete replacement", () => {
    const result = computeLineDiff("a\nb", "x\ny");
    expect(result.filter((l) => l.type === "removed")).toHaveLength(2);
    expect(result.filter((l) => l.type === "added")).toHaveLength(2);
  });
});

describe("collapseDiff — focused hunks for incremental changes (#3)", () => {
  it("collapses a long unchanged run far from any change into one gap", () => {
    // 30 unchanged lines, then one changed line at the end.
    const before = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const after = before + "\nNEW";
    const rows = collapseDiff(computeLineDiff(before, after), 3);
    const gaps = rows.filter((r) => r.type === "gap");
    expect(gaps).toHaveLength(1);
    // The gap stands in for the unchanged lines beyond the 3-line context.
    expect((gaps[0] as any).count).toBeGreaterThan(20);
    // The added line survives.
    expect(rows.some((r) => r.type === "added" && (r as any).content === "NEW")).toBe(true);
  });

  it("keeps `context` unchanged lines around each change", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "CHANGED");
    const rows = collapseDiff(computeLineDiff(before, after), 2);
    // Lines l8,l9 (before) and l11,l12 (after) are within 2 of the change.
    const kept = rows.filter((r) => r.type !== "gap").map((r) => (r as any).content);
    expect(kept).toContain("l8");
    expect(kept).toContain("l9");
    expect(kept).toContain("l11");
    expect(kept).toContain("l12");
    expect(kept).toContain("CHANGED");
  });

  it("does not collapse a tiny unchanged run (a 1-line marker saves nothing)", () => {
    const rows = collapseDiff(computeLineDiff("a\nb\nc", "X\nb\nY"), 0);
    // With context 0, the single unchanged 'b' is a 1-line run → kept, not gapped.
    expect(rows.some((r) => r.type === "gap")).toBe(false);
    expect(rows.some((r) => r.type === "unchanged" && (r as any).content === "b")).toBe(true);
  });

  it("returns no gaps when everything changed", () => {
    const rows = collapseDiff(computeLineDiff("a\nb", "x\ny"), 3);
    expect(rows.some((r) => r.type === "gap")).toBe(false);
  });
});
