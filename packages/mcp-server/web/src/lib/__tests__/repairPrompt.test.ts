import { describe, it, expect } from "vitest";
import { buildRepairPrompt } from "../repairPrompt";

const baseInput = {
  sessionId: "session_abc",
  decisionContext: "Which cache layer?",
  options: [
    { id: "o1", title: "Redis", description: "In-memory", pros: ["fast"], cons: ["one more service"], recommendation: true },
    { id: "o2", title: "CDN", description: "Edge", pros: ["no infra"], cons: ["cache-invalidation harder"] },
  ],
  chosenOptionId: "o1",
  chosenReasoning: "Existing Redis already deployed",
  resolvedAt: "2026-04-10T10:00:00.000Z",
  userNote: "Team switched to serverless; revisit.",
};

describe("buildRepairPrompt", () => {
  it("includes session id, decision context, and user note", () => {
    const md = buildRepairPrompt(baseInput);
    expect(md).toContain("Which cache layer?");
    expect(md).toContain("session_abc");
    expect(md).toContain("Team switched to serverless");
  });

  it("marks the chosen option with ✅ and rejected ones with ❌", () => {
    const md = buildRepairPrompt(baseInput);
    expect(md).toMatch(/✅ \*\*Redis\*\*/);
    expect(md).toMatch(/❌ \*\*CDN\*\*/);
  });

  it("includes the recommendation star on recommended options", () => {
    const md = buildRepairPrompt(baseInput);
    expect(md).toContain("⭐");
  });

  it("surfaces the previous reasoning verbatim so the fresh agent can engage with it", () => {
    const md = buildRepairPrompt(baseInput);
    expect(md).toContain("Existing Redis already deployed");
  });

  it("lists rejected options in a dedicated section", () => {
    const md = buildRepairPrompt(baseInput);
    expect(md).toContain("**What I rejected:** CDN");
  });

  it("omits the 'why reconsidering' block when no userNote is provided", () => {
    const md = buildRepairPrompt({ ...baseInput, userNote: undefined });
    expect(md).not.toContain("Why I'm reconsidering");
  });

  it("formats resolvedAt as YYYY-MM-DD", () => {
    const md = buildRepairPrompt(baseInput);
    expect(md).toContain("on 2026-04-10");
  });

  it("instructs the fresh agent to use MCP tools and not assume prior decision holds", () => {
    const md = buildRepairPrompt(baseInput);
    expect(md.toLowerCase()).toContain("present_findings");
    expect(md.toLowerCase()).toContain("don't assume");
  });

  it("handles options with no pros / cons / description cleanly", () => {
    const md = buildRepairPrompt({
      ...baseInput,
      options: [
        { id: "o1", title: "A" },
        { id: "o2", title: "B" },
      ],
    });
    expect(md).toContain("**A**");
    expect(md).toContain("**B**");
    // Bare titles, no blank bullet lines
    expect(md).not.toMatch(/^\s*\+\s*$/m);
    expect(md).not.toMatch(/^\s*−\s*$/m);
  });
});
