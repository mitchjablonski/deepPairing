import { describe, it, expect } from "vitest";
import { formatStyleWarnings, formatProseStyleWarnings } from "../tool-helpers.js";

/**
 * "Write to your pair" — the STYLE echo appended to a present_* result.
 *
 * The contract these tests pin is deliberately narrow: WARN ONLY, silent when
 * clean, and never more than five lines. Everything about recording,
 * versioning and gating happens before this function is called and is not
 * affected by it — there is no path from here back into the store.
 */
const MESSY =
  "WHAT THE RESEARCH SETTLED: the build/test/deploy loop is slow (it respawns the " +
  "daemon, which costs a second or two); shop routing outranks healthy elites → fewer relics.";

describe("formatStyleWarnings", () => {
  it("is silent when the prose is clean", () => {
    expect(
      formatStyleWarnings("research", {
        summary: "Shop routing now outranks healthy elites.",
        findings: [{ category: "a", detail: "The daemon binds one port.", significance: "low" }],
      }),
    ).toBe("");
  });

  it("is silent for an artifact type with no prose fields mapped", () => {
    expect(formatStyleWarnings("nope", { summary: MESSY })).toBe("");
  });

  it("names the clarity score and the field, and says it changed nothing", () => {
    const out = formatStyleWarnings("research", { summary: MESSY, findings: [] });
    expect(out).toMatch(/^\n\nSTYLE \(clarity \d{1,3}\/100\) — house prose, warn only\. Nothing was changed\./);
    expect(out).toContain("- summary: ");
  });

  it("caps at four violation lines and counts the rest", () => {
    const out = formatStyleWarnings("debrief", {
      summary: MESSY,
      sections: [{ title: "t", body: MESSY }],
      needsYourEyes: [{ what: MESSY, why: MESSY }],
    });
    const lines = out.trim().split("\n");
    // One header + at most four violation lines.
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(4);
    // "(+N more)", not "N more in the UI" — the clarity chip is hidden on a
    // good-enough score, so the block must not promise a control on screen.
    expect(lines[0]).toMatch(/\(\+\d+ more\)$/);
    expect(lines[0]).not.toContain("in the UI");
  });

  it("spends its four lines on four DISTINCT rules, not four of the same one", () => {
    // Five semicolons and one arrow. Pre-review the semicolons took every slot
    // and the agent paid four lines for one lesson.
    const out = formatStyleWarnings("research", {
      summary:
        "One; two; three; four; five. The daemon → the UI. WHAT THE RESEARCH SETTLED here.",
      findings: [],
    });
    const rules = out
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(rules.length).toBeGreaterThan(1);
    expect(rules.filter((l) => l.includes("Semicolon"))).toHaveLength(1);
  });

  it("echoes style for a bare prose string too (answer_question's reply)", () => {
    expect(formatProseStyleWarnings("answer", "The store binds one port.")).toBe("");
    const out = formatProseStyleWarnings("answer", MESSY);
    expect(out).toContain("- answer: ");
    expect(out).toMatch(/^\n\nSTYLE \(clarity \d{1,3}\/100\)/);
  });

  it("ranks the worst severity first", () => {
    // An arrow chain is high severity; wordiness is low.
    const out = formatStyleWarnings("research", {
      summary: "We utilize the store. The daemon → the UI.",
      findings: [],
    });
    const first = out.trim().split("\n").find((l) => l.startsWith("- "))!;
    expect(first).toContain("arrows belong in visuals[] diagrams");
  });

  it("reports the concrete field path so the agent knows where to look", () => {
    const out = formatStyleWarnings("debrief", {
      summary: "Fine.",
      needsYourEyes: [{ what: "Check the store.", why: "Because." }, { what: MESSY, why: "Because." }],
    });
    expect(out).toContain("needsYourEyes[1].what:");
  });

  it("never throws on malformed content — it returns the empty string", () => {
    for (const content of [null, undefined, "a string", 42, { findings: "nope", summary: 7 }, []]) {
      expect(() => formatStyleWarnings("research", content)).not.toThrow();
    }
    expect(formatStyleWarnings("research", null)).toBe("");
  });

  it("ignores code fences, tables and paths inside prose fields", () => {
    expect(
      formatStyleWarnings("research", {
        summary:
          "Here is the shape.\n\n```ts\nconst a = b; // LOUD build/test/deploy → x\n```\n\nSee packages/shared/src/prose-lint.ts.",
        findings: [],
      }),
    ).toBe("");
  });
});
