import { describe, it, expect } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { computeAttention, type AttentionItem } from "../attention";
import { afterFor, briefRiskClass, copyFor, copyLineText, ifIgnoredFor, reachFrom, whyFor, type AgentReach } from "../attentionCopy";

/**
 * #430 slice 1 — the ONE copy module both needs-you surfaces read
 * (PendingBanner with the bar OFF, the Next-up bar with it ON). Why / if
 * ignored / after per kind, the brief's blocking copy, and reach (#457 D3)
 * governing both the if-ignored and the after line.
 */
function art(type: string, over: Partial<Artifact> & Record<string, unknown> = {}): Artifact {
  return {
    id: `${type}_1`, sessionId: "s1", type, version: 1, parentId: null, title: `${type} title`, status: "draft",
    content: {}, agentReasoning: null, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", ...over,
  } as Artifact;
}
const BRIEF_CONTEXT = [
  "Decide alone: naming and file layout",
  "Will ask: none",
  "Risk class: escalated",
  "Why: touches the Stop hook",
  "Review: packet",
].join("\n");
const brief = (over: Record<string, unknown> = {}) => art("spec", {
  id: "brief", title: "Lead-side worker-stop notice",
  content: { objective: "Tell the lead when a worker stops", requirements: [], context: BRIEF_CONTEXT, tasks: [{ title: "a" }, { title: "b" }, { title: "c" }] },
  ...over,
});
const itemFor = (a: Artifact): AttentionItem => computeAttention({ artifacts: [a] }).next!;

describe("why — derived from the item's own content, never invented", () => {
  it.each<[string, Artifact, string]>([
    ["decision → its context", art("decision", { content: { context: "Two stores fit", options: [], decisionId: "d" } }), "Two stores fit"],
    ["brief → its objective", brief(), "Tell the lead when a worker stops"],
    ["ordinary spec → its objective", art("spec", { content: { objective: "Spec goal", requirements: [] } }), "Spec goal"],
    ["findings → the summary", art("research", { content: { summary: "Cache misses 88%", findings: [] } }), "Cache misses 88%"],
    ["changeset → the summary", art("changeset", { content: { summary: "Three files", files: [] } }), "Three files"],
    ["plan → no explanatory field, no why", art("plan", { content: { steps: [] } }), ""],
    ["code_change → no why", art("code_change", { content: { filePath: "x", changeType: "modify", before: "", after: "", reasoning: "r" } }), ""],
  ])("%s", (_name, a, why) => {
    expect(whyFor(itemFor(a), [a])).toBe(why);
  });

  it("waiting kinds say what you asked", () => {
    const q = { id: "q", title: "why a lock?", createdAt: "", kind: "question" } as AttentionItem;
    expect(whyFor(q, [])).toBe("You asked: why a lock?");
    expect(whyFor({ ...q, kind: "request", title: "a plan" }, [])).toBe("You asked for: a plan");
    expect(whyFor({ ...q, kind: "revision", title: "Plan" }, [])).toBe("You requested changes to Plan");
  });
});

describe("if you leave it — conditional, never 'Claude is stopped' as a fact", () => {
  it.each<[string, Artifact, string]>([
    ["decision", art("decision", { content: { context: "c", options: [], decisionId: "d" } }), "Your choice is needed before this work proceeds"],
    ["brief", brief(), "Approval required before this work proceeds"],
    ["plan", art("plan", { content: { steps: [] } }), "Approval required before this work proceeds"],
    ["finding (non-blocking)", art("research", { content: { summary: "s", findings: [] } }), "Not blocking — Claude can keep working"],
  ])("%s, live", (_name, a, text) => {
    expect(ifIgnoredFor(itemFor(a), "live")).toBe(text);
  });

  it.each<[AgentReach, string]>([
    ["replay", "History — nothing waits on this now"],
    ["gone", "Claude has exited — this waits for the session to resume"],
    ["disconnected", "Last known: approval required before this work proceeds"],
  ])("reach %s governs it too", (reach, text) => {
    expect(ifIgnoredFor(itemFor(brief()), reach)).toBe(text);
  });

  it("waiting / flag / held kinds have no if-ignored line (they are not yours to answer)", () => {
    for (const kind of ["question", "request", "revision", "flag", "held"] as const) {
      expect(ifIgnoredFor({ id: "x", title: "x", createdAt: "", kind }, "live")).toBe("");
    }
  });
});

describe("after — what happens when you respond", () => {
  it("brief: Approve → Claude builds N tasks · Request changes → Claude revises the brief", () => {
    const b = brief();
    expect(afterFor(itemFor(b), [b], "live")).toBe("Approve → Claude builds 3 tasks · Request changes → Claude revises the brief");
  });

  it("brief without tasks does not invent a count", () => {
    const b = brief({ content: { objective: "o", requirements: [], context: BRIEF_CONTEXT } });
    expect(afterFor(itemFor(b), [b], "live")).toBe("Approve → Claude starts the work · Request changes → Claude revises the brief");
  });

  it("plan, decision and review keep their existing copy", () => {
    const p = art("plan", { content: { steps: [{}, {}] } });
    expect(afterFor(itemFor(p), [p], "live")).toBe("Approve → Claude executes 2 steps · Request changes → Claude revises the plan");
    const d = art("decision", { content: { context: "c", options: [], decisionId: "d" } });
    expect(afterFor(itemFor(d), [d], "live")).toBe("Claude continues with the option you pick");
    const r = art("research", { content: { summary: "s", findings: [] } });
    expect(afterFor(itemFor(r), [r], "live")).toBe("Your verdict reaches Claude on its next check (usually < 30s)");
  });

  it.each<[AgentReach, RegExp]>([
    ["gone", /^Saved — Claude acts on your verdict when the session resumes$/],
    ["disconnected", /^This tab is offline/],
    ["replay", /^Replay is read-only/],
  ])("brief, reach %s: never promises the build", (reach, expected) => {
    const b = brief();
    const after = afterFor(itemFor(b), [b], reach);
    expect(after).toMatch(expected);
    expect(after).not.toContain("builds");
  });
});

describe("copyFor / copyLineText — the line both surfaces show", () => {
  it("a draft brief reads REVIEW <title> · Risk: escalated · <if ignored> · <after>", () => {
    const b = brief();
    const c = copyFor(itemFor(b), [b], "live");
    expect(c.lane).toBe("REVIEW");
    expect(c.tags).toEqual(["Risk: escalated"]);
    expect(copyLineText("Lead-side worker-stop notice", c)).toBe(
      "REVIEW Lead-side worker-stop notice · Risk: escalated · Approval required before this work proceeds · Approve → Claude builds 3 tasks · Request changes → Claude revises the brief",
    );
  });

  it("tags: HIGH for a high-stakes decision, Demo for a demo item, in that order", () => {
    const d = art("decision", { sessionId: "demo_1", content: { context: "c", options: [], decisionId: "d", stakes: "high" } });
    const c = copyFor(itemFor(d), [d], "live");
    expect(c.lane).toBe("DECIDE");
    expect(c.tags).toEqual(["HIGH", "Demo"]);
  });

  it("Risk only when the brief states it; an ordinary spec has none", () => {
    expect(briefRiskClass(brief())).toBe("escalated");
    expect(briefRiskClass(art("spec", { content: { objective: "o", requirements: [], context: "Risk class: escalated" } }))).toBeNull();
  });

  it("reachFrom: replay > offline > exited > live", () => {
    expect(reachFrom({ replay: true, tabOffline: true, agentGone: true })).toBe("replay");
    expect(reachFrom({ replay: false, tabOffline: true, agentGone: true })).toBe("disconnected");
    expect(reachFrom({ replay: false, tabOffline: false, agentGone: true })).toBe("gone");
    expect(reachFrom({ replay: false, tabOffline: false, agentGone: false })).toBe("live");
  });
});
