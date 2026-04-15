import { describe, it, expect } from "vitest";
import { fuzzyScore } from "../fuzzy";

describe("fuzzyScore", () => {
  it("returns 0 for empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("returns -1 when query chars not found in target", () => {
    expect(fuzzyScore("xyz", "abcdef")).toBe(-1);
  });

  it("matches exact substring", () => {
    const score = fuzzyScore("auth", "Authentication System");
    expect(score).toBeGreaterThan(0);
  });

  it("gives higher score for consecutive matches", () => {
    const consecutive = fuzzyScore("auth", "auth_service");
    const scattered = fuzzyScore("auth", "axuxxtxxhxx"); // no word boundaries
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it("gives bonus for word boundary matches", () => {
    const boundary = fuzzyScore("as", "auth_service"); // matches 'a' at start, 's' at boundary
    const mid = fuzzyScore("as", "baste"); // matches 'a' and 's' mid-word
    expect(boundary).toBeGreaterThan(mid);
  });

  it("is case insensitive", () => {
    expect(fuzzyScore("AUTH", "authentication")).toBeGreaterThan(0);
    expect(fuzzyScore("auth", "AUTHENTICATION")).toBeGreaterThan(0);
  });

  it("returns -1 for partial query match", () => {
    // Query "abcz" has 'z' not matchable after 'c' in "abcdef"
    expect(fuzzyScore("abcz", "abcdef")).toBe(-1);
  });

  it("handles single character queries", () => {
    expect(fuzzyScore("a", "apple")).toBeGreaterThan(0);
    expect(fuzzyScore("z", "apple")).toBe(-1);
  });
});
