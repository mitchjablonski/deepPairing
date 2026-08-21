/**
 * Q6 (#232) — the PR-review flow's GUIDANCE surfaces, and whether the mechanism
 * behind them exists.
 *
 * Round 12 named the recurring failure: "stated guarantees whose mechanism has
 * a hole". This batch adds a lot of prose — a rewritten /deeppairing:review-pr,
 * an aligned /deeppairing:post-pr, a SKILL.md section — and prose is exactly
 * where that failure hides. So this file tests two different things:
 *
 *   1. FORM — the two PR command files still parse the way the other four do
 *      (a plugin command whose frontmatter drifts silently stops being a
 *      command);
 *   2. TRUTH — every non-obvious thing that guidance promises is actually
 *      reachable. Most sharply: the ledger sweep tells the agent to write "you
 *      rejected this on <date>: '<reason>'" on someone else's PR. That sentence
 *      is only writable if `recall` actually returns a date AND the reason.
 *      Until Q6 it returned the reason alone, so half the promised sentence was
 *      unwritable and the agent would have had to invent or omit it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { getGlobalStore } from "../../store/global-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ → mcp → src → mcp-server → packages → repo root
const repoRoot = path.resolve(here, "../../../../..");
const commandsDir = path.join(repoRoot, "claude-plugin", "commands");
const skillPath = path.join(repoRoot, "claude-plugin", "skills", "pairing-protocol", "SKILL.md");

const read = (p: string) => fs.readFileSync(p, "utf-8");
const reviewPr = () => read(path.join(commandsDir, "review-pr.md"));
const postPr = () => read(path.join(commandsDir, "post-pr.md"));
const skill = () => read(skillPath);

/** Markdown hard-wraps at ~78 columns, so a phrase this file asserts on is as
 *  likely as not to straddle a newline. Collapse whitespace before matching —
 *  the tests are about the WORDS being present, never about where the wrap
 *  happens to fall today. */
const flat = (s: string) => s.replace(/\s+/g, " ");

/** Split a command file into its YAML frontmatter keys and its body. */
function parseCommand(src: string): { keys: string[]; values: Record<string, string>; body: string } {
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("no frontmatter block");
  const keys: string[] = [];
  const values: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (kv) { keys.push(kv[1]!); values[kv[1]!] = kv[2]!; }
  }
  return { keys, values, body: m[2]! };
}

describe("Q6 — the PR command files keep the shape of the other four", () => {
  const ALL = ["post-pr.md", "review-pr.md", "review.md", "share.md", "stance.md", "start.md"];

  it("the command set is exactly the six on disk (a new file must be a deliberate addition)", () => {
    expect(fs.readdirSync(commandsDir).sort()).toEqual(ALL);
  });

  it("every command parses, and the two PR commands use the same frontmatter keys as their siblings", () => {
    const parsed = Object.fromEntries(ALL.map((f) => [f, parseCommand(read(path.join(commandsDir, f)))]));
    for (const [file, p] of Object.entries(parsed)) {
      // `description` is what Claude Code lists; without it the command is
      // invisible in the picker.
      expect(p.keys, `${file} frontmatter`).toContain("description");
      expect(p.values.description!.length, `${file} description`).toBeGreaterThan(20);
      // Only the two keys the plugin format defines — a typo'd key is silently
      // ignored by the loader, which is exactly how it would go unnoticed.
      expect(p.keys.every((k) => k === "description" || k === "argument-hint"), `${file} keys: ${p.keys}`).toBe(true);
      expect(p.body.trim().length, `${file} body`).toBeGreaterThan(50);
    }
    // Both PR commands take an argument, so both must hint it.
    expect(parsed["review-pr.md"]!.keys).toEqual(["description", "argument-hint"]);
    expect(parsed["post-pr.md"]!.keys).toEqual(["description", "argument-hint"]);
    expect(parsed["review-pr.md"]!.values["argument-hint"]).toBe("[pr-number-or-url]");
    expect(parsed["post-pr.md"]!.values["argument-hint"]).toBe("[pr-number-or-url]");
  });

  it("both PR commands substitute $ARGUMENTS — an argument-hint with nothing to fill is a lie", () => {
    expect(reviewPr()).toContain("$ARGUMENTS");
    expect(postPr()).toContain("$ARGUMENTS");
  });
});

describe("Q6 — review-pr.md carries the whole in-tandem arc, in order", () => {
  it("names each of the six moves and the tool that performs it", () => {
    const text = reviewPr();
    // (a) ingest — the PR is more than its diff.
    expect(text).toContain("gh pr view");
    expect(text).toContain("gh pr diff");
    // (b) orient BEFORE detail — the move that separates reviewing from skimming.
    expect(text).toContain("present_explainer");
    expect(text).toMatch(/blast radius/i);
    // (c) the diff onto the rich surface, as someone else's code.
    expect(text).toContain("present_changeset");
    expect(text).toContain('reviewIntent: "external"');
    expect(text).toContain('kind: "github-pr"');
    // (d) findings + the ledger sweep.
    expect(text).toContain("present_findings");
    expect(text).toContain("recall");
    // (e) discuss.
    expect(text).toContain("check_feedback");
    expect(text).toContain("answer_question");
    // (f) conclude.
    expect(text).toContain("post_pr_review");
    expect(text).toContain("/deeppairing:share");
  });

  it("the moves appear in the order the arc requires — orient before diff before findings before post", () => {
    const text = reviewPr();
    const at = (needle: string) => {
      const i = text.indexOf(needle);
      expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    expect(at("present_explainer")).toBeLessThan(at("present_changeset"));
    expect(at("present_changeset")).toBeLessThan(at("present_findings"));
    expect(at("present_findings")).toBeLessThan(at("post_pr_review"));
  });

  it("keeps the pre-Q6 good bones: severity gating and reject-remembers", () => {
    const text = reviewPr();
    expect(text).toContain("REQUEST_CHANGES");
    expect(flat(text)).toMatch(/high or critical|critical\/high/);
    expect(flat(text)).toMatch(/reject.*reason|reason.*recorded/is);
  });

  it("states the external-review semantics the agent must not violate", () => {
    const text = reviewPr();
    // The three failure modes of pointing a build-tool at someone else's code.
    expect(flat(text)).toMatch(/do not apply, revise, or "fix"/i);
    expect(text).toMatch(/stay local|stays local/i);
    expect(flat(text)).toMatch(/nothing posts until|until I say/i);
  });

  it("promises the ledger citation in the exact shape recall can support", () => {
    const text = reviewPr();
    expect(text).toContain("<concept>");
    expect(text).toContain("<date>");
    expect(text).toMatch(/rejected on/);
    // And says not to fabricate one — the failure mode of any "find a match" rule.
    expect(flat(text)).toMatch(/don.t manufacture|do not manufacture/i);
  });

  it("APPROVE is offered as a real outcome, not a hole in the flow", () => {
    // The commonest result of being pinged on a PR. Both PR commands must say so,
    // and neither may push the agent toward inventing findings to avoid it.
    expect(reviewPr()).toContain("APPROVE");
    expect(flat(reviewPr())).toMatch(/don.t invent findings|never invent findings/i);
    expect(postPr()).toContain("APPROVE");
  });

  it("post-pr.md is honest that rejection is per-ARTIFACT, not per-finding", () => {
    // There is no per-finding verdict in the product (grep: none). The old copy
    // said "only the findings we landed on together get posted", which is only
    // true if the pair revised the artifact. Say the actual mechanism.
    const text = postPr();
    expect(text).toContain("revise_artifact");
    expect(flat(text)).toMatch(/per-artifact/i);
    expect(text).toMatch(/filePath.*lineStart|lineStart/);
  });

  it("both PR commands tell the agent to STOP on a gh failure rather than improvise", () => {
    expect(flat(reviewPr())).toMatch(/tell me plainly and stop/i);
    expect(flat(postPr())).toMatch(/don.t work around it/i);
  });
});

describe("Q6 — SKILL.md's PR section agrees with the command", () => {
  it("carries the arc's load-bearing steps without re-explaining the whole command", () => {
    const text = skill();
    const section = text.slice(text.indexOf("## Pairing on a PR"), text.indexOf("## Debugging & incident cadence"));
    expect(section).toContain("/deeppairing:review-pr");
    expect(section).toContain("present_explainer");
    expect(section).toContain('reviewIntent: "external"');
    expect(section).toContain("recall");
    expect(section).toContain("post_pr_review");
    expect(section).toContain("APPROVE");
    // Tight: the command carries the detail, this is the map.
    expect(section.split("\n").length).toBeLessThan(70);
  });

  it("the skill's post_pr_review entry and the command agree on the event mapping", () => {
    for (const text of [skill(), reviewPr(), postPr()]) {
      expect(text).toContain("REQUEST_CHANGES");
      expect(flat(text)).toMatch(/high\/critical|high or critical|critical\/high/);
    }
  });

  it("does not tell the agent to debrief an external review", () => {
    const text = skill();
    const section = text.slice(text.indexOf("## Pairing on a PR"), text.indexOf("## Debugging & incident cadence"));
    expect(section).not.toContain("present_debrief");
  });
});

// --- the mechanism behind the ledger sweep ------------------------------------

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);

describe("Q6 — the ledger sweep is WRITABLE: recall returns the reason AND the date", () => {
  beforeEach(() => {
    // A stance the human recorded a while back, exactly as a reject-and-remember
    // cycle in another project would have left it.
    getGlobalStore().recordInstance("in-process rate limiting", {
      project: "gateway",
      sessionId: "s_old",
      verdict: "rejected",
      reason: "we standardised on the edge limiter; in-process drifts per instance",
      at: "2026-06-14T09:30:00.000Z",
    });
  });

  it("recall gives the agent every fragment the promised finding sentence needs", async () => {
    // "This PR introduces <concept>, which you rejected on <date>: '<reason>'."
    const res = await callTool("recall", { mode: "philosophy", query: "in-process rate limiting" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("in-process rate limiting");      // <concept>
    expect(res.text).toContain("2026-06-14");                     // <date>  ← added by Q6
    expect(res.text).toContain("we standardised on the edge limiter"); // <reason>
    expect(res.text).toContain("[AVOID]");                        // the stance itself
  });

  it("the date is a DATE, not a timestamp — a review comment shouldn't quote milliseconds", () => {
    // (Asserted on the formatted text produced above.)
    return callTool("recall", { mode: "philosophy", query: "in-process rate limiting" }).then((res) => {
      expect(res.text).toMatch(/last on 2026-06-14/);
      expect(res.text).not.toContain("2026-06-14T09:30");
    });
  });

  it("no match → recall says so plainly, so the agent has nothing to fabricate from", async () => {
    const res = await callTool("recall", { mode: "philosophy", query: "kubernetes operators" });
    expect(res.text).toMatch(/No philosophy-ledger entries match/);
  });
});
