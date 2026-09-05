import { describe, expect, it } from "vitest";
import { artifactProposal } from "../artifact-preflight.js";

describe("artifact preflight projection", () => {
  it("trims projected strings and drops whitespace-only values", () => {
    expect(artifactProposal("code_change", "", {
      filePath: "  src/cache.ts  ",
      reasoning: "  keep cache ownership local  ",
      concept: { name: "   " },
    })).toEqual({
      text: ["src/cache.ts", "keep cache ownership local"],
      paths: ["src/cache.ts"],
      concepts: [],
      advisory: false,
    });
  });

  it("marks debrief narrative and external review content advisory", () => {
    expect(artifactProposal("debrief", "Debrief", { summary: "What happened" })?.advisory).toBe(true);
    expect(artifactProposal("changeset", "PR", { files: [], reviewIntent: "external" })?.advisory).toBe(true);
    expect(artifactProposal("changeset", "Local", { files: [] })?.advisory).toBe(false);
  });
});
