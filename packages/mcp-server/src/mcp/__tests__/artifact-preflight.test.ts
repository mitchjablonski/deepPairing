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

describe("artifact preflight projection — page (#680)", () => {
  it("projects title, summary, every visible text block and the concept; drops scripts; raw-text reverse lane", () => {
    const p = artifactProposal("page", "Hosting proposal", {
      summary: "Which host should we use?",
      html: "<h1>Hosting</h1><script>const x = 'Railway';</script><p>Move the API to Railway.</p><td>None</td>",
      concept: { name: "pay-per-request hosting" },
    });
    expect(p).toEqual({
      text: ["Hosting proposal", "Which host should we use?", "Hosting", "Move the API to Railway.", "None"],
      paths: [],
      concepts: ["pay-per-request hosting"],
      advisory: false,
      rawEditText: true,
    });
  });

  it("tolerates a page with no html", () => {
    expect(artifactProposal("page", "T", {})?.text).toEqual(["T"]);
  });
});
