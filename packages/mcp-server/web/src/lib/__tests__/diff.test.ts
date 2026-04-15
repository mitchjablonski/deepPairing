import { describe, it, expect } from "vitest";
import { computeLineDiff } from "../diff";

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
