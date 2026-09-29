import { describe, it, expect } from "vitest";
import type { Artifact, Comment, Request } from "@deeppairing/shared";
import { countUnansweredQuestions } from "@deeppairing/shared";
import { computeAttention, type AttentionInput, type PrimaryLane, type SummaryLane } from "../attention";
import { computePending, REVIEWABLE_TYPES } from "../pending";

/**
 * #430 PR 1a — the shared attention selector (docs/design/attention-hierarchy.md
 * §4.1, §4.3). Parity with today's counters, the "+N high decision" rule,
 * oldest-first ordering, and every lane combination of the precedence rules.
 */
let seq = 0;
const ts = () => `2026-06-01T00:${String(seq++).padStart(2, "0")}:00.000Z`;
function art(type: string, status: string, over: Partial<Artifact> & Record<string, unknown> = {}): Artifact {
  const id = (over.id as string) ?? `${type}_${status}_${seq}`;
  return {
    id, sessionId: "s1", type, version: 1, parentId: null, title: `${type} ${status}`, status,
    content: {}, agentReasoning: null, createdAt: ts(), updatedAt: ts(), ...over,
  } as Artifact;
}
function question(id: string, artifactId: string, over: Partial<Comment> = {}): Comment {
  return {
    id, sessionId: "s1", target: { artifactId }, parentCommentId: null, author: "human",
    content: `q ${id}`, acknowledged: false, createdAt: ts(), intent: "question", ...over,
  } as Comment;
}

const TYPES = [...REVIEWABLE_TYPES, "explainer", "reasoning"];
const STATUSES = ["draft", "reviewing", "approved", "revised", "rejected", "superseded", "retracted", "obsolete"];

describe("parity with today's counters (no counting rule changes in PR 1a)", () => {
  it("Decide == computePending's drafts for every type × status", () => {
    seq = 0;
    const artifacts = TYPES.flatMap((t) => STATUSES.map((s) => art(t, s)));
    const pending = computePending(artifacts);
    const a = computeAttention({ artifacts });
    expect(a.lanes.decide.length).toBe(pending.total);
    expect(new Set(a.lanes.decide.map((d) => d.id))).toEqual(new Set(pending.drafts.map((d) => d.id)));
  });

  it("Read holds exactly the drafts that are not awaiting review (explainer, reasoning) — PR 0's dot rule", () => {
    seq = 0;
    const artifacts = TYPES.flatMap((t) => STATUSES.map((s) => art(t, s)));
    const read = computeAttention({ artifacts }).lanes.read;
    expect(new Set(read.map((r) => r.id))).toEqual(
      new Set(artifacts.filter((x) => x.status === "draft" && !REVIEWABLE_TYPES.has(x.type)).map((x) => x.id)),
    );
  });

  it("Waiting's question count == the shared thread-aware countUnansweredQuestions (App header count)", () => {
    seq = 0;
    const comments: Record<string, Comment[]> = {
      a1: [
        question("q1", "a1"),
        // answered by an agent reply → not open
        question("q2", "a1"),
        { ...question("r2", "a1"), author: "agent", intent: undefined, parentCommentId: "q2" } as Comment,
        // resolved by the human → not open
        question("q3", "a1", { humanResolvedAt: ts() } as Partial<Comment>),
      ],
      __session__: [question("q4", "__session__")],
    };
    const a = computeAttention({ artifacts: [], comments });
    const questions = a.lanes.waiting.filter((w) => w.kind === "question");
    expect(questions.length).toBe(countUnansweredQuestions(Object.values(comments).flat()));
    expect(questions.map((q) => q.id).sort()).toEqual(["q1", "q4"]);
  });

  it("Waiting also holds unserved requests and `revised` artifacts; served requests drop out", () => {
    seq = 0;
    const requests = [
      { id: "r_open", text: "explain", intent: "explain", createdAt: ts() },
      { id: "r_done", text: "plan", intent: "plan", createdAt: ts(), servedByArtifactId: "x" },
    ] as Request[];
    const a = computeAttention({ artifacts: [art("plan", "revised", { id: "rev" })], requests });
    expect(a.lanes.waiting.map((w) => [w.id, w.kind])).toEqual([["r_open", "request"], ["rev", "revision"]]);
  });
});

describe("oldest-first `next` and the '+N high decision' count", () => {
  it("next is the OLDEST Decide item regardless of input order or stakes", () => {
    const artifacts = [
      art("decision", "draft", { id: "d_new", createdAt: "2026-06-01T03:00:00.000Z", content: { stakes: "high" } }),
      art("research", "draft", { id: "r_old", createdAt: "2026-06-01T01:00:00.000Z" }),
      art("plan", "draft", { id: "p_mid", createdAt: "2026-06-01T02:00:00.000Z" }),
    ];
    const a = computeAttention({ artifacts });
    expect(a.lanes.decide.map((d) => d.id)).toEqual(["r_old", "p_mid", "d_new"]);
    expect(a.next?.id).toBe("r_old");
    expect(a.lanes.decide.map((d) => d.kind)).toEqual(["review", "review-blocking", "decision"]);
  });

  it("counts only open DECISIONS with stakes 'high' — never findings' significance, never `next` itself", () => {
    const artifacts = [
      art("decision", "draft", { id: "d1", createdAt: "2026-06-01T01:00:00.000Z", content: { stakes: "high" } }),
      art("decision", "draft", { id: "d2", createdAt: "2026-06-01T02:00:00.000Z", content: { stakes: "high" } }),
      art("decision", "draft", { id: "d3", createdAt: "2026-06-01T03:00:00.000Z", content: { stakes: "medium" } }),
      art("decision", "draft", { id: "d4", createdAt: "2026-06-01T04:00:00.000Z", content: {} }),
      art("decision", "approved", { id: "d5", createdAt: "2026-06-01T05:00:00.000Z", content: { stakes: "high" } }),
      ...[6, 7, 8, 9, 10].map((i) => art("research", "draft", {
        id: `f${i}`, createdAt: `2026-06-01T1${i - 6}:00:00.000Z`,
        content: { findings: [{ significance: "high" }] },
      })),
    ];
    const a = computeAttention({ artifacts });
    expect(a.next?.id).toBe("d1");
    // d2 only: d1 is `next`, d3 medium, d4 unset, d5 resolved, findings don't count.
    expect(a.highDecisionsBeyondNext).toBe(1);
    expect(a.line.summary[0]).toEqual({ lane: "high-decision", count: 1 });
  });

  it("when `next` is an older finding, every high decision behind it counts", () => {
    const artifacts = [
      art("research", "draft", { id: "f", createdAt: "2026-06-01T01:00:00.000Z" }),
      art("decision", "draft", { id: "d", createdAt: "2026-06-01T02:00:00.000Z", content: { stakes: "high" } }),
    ];
    const a = computeAttention({ artifacts });
    expect(a.next?.id).toBe("f");
    expect(a.highDecisionsBeyondNext).toBe(1);
  });
});

describe("§4.3 precedence — every combination of System failure × Decide × Flag × Waiting × Held (× Read)", () => {
  type Combo = { failure: boolean; decide: boolean; flag: boolean; waiting: boolean; held: boolean; read: boolean };
  const combos: Combo[] = [];
  for (let m = 0; m < 64; m++) {
    combos.push({ failure: !!(m & 1), decide: !!(m & 2), flag: !!(m & 4), waiting: !!(m & 8), held: !!(m & 16), read: !!(m & 32) });
  }

  function build(c: Combo): AttentionInput {
    seq = 0;
    const artifacts: Artifact[] = [];
    if (c.decide) artifacts.push(art("research", "draft", { id: "dec" }));
    // A flag on a NON-draft artifact: flags are System, not Decide.
    if (c.flag) artifacts.push(art("research", "approved", { id: "sec", secretWarnings: [{ label: "AWS key", line: 1 }] } as any));
    if (c.read) artifacts.push(art("explainer", "draft", { id: "exp" }));
    return {
      artifacts,
      comments: c.waiting ? { a: [question("q", "a")] } : {},
      system: { disconnected: c.failure, holds: c.held ? [{ id: "h", title: "held", at: ts() }] : [] },
    };
  }

  // The oracle, written straight from the three rules in the doc.
  function expected(c: Combo): { prefix: string | null; primary: PrimaryLane; summary: SummaryLane[] } {
    const primary: PrimaryLane = c.decide ? "decide" : c.flag ? "flag" : c.waiting ? "waiting" : c.held ? "held" : "nothing";
    const summary: SummaryLane[] = [];
    if (c.decide) summary.push("decide"); // one Decide item → no "+N high"
    if (c.flag && primary !== "flag") summary.push("flags");
    if (c.waiting && primary !== "waiting") summary.push("waiting");
    if (c.held && primary !== "held") summary.push("held");
    if (c.read) summary.push("read");
    return { prefix: c.failure ? "disconnected" : null, primary, summary };
  }

  it.each(combos.map((c) => [
    `failure=${+c.failure} decide=${+c.decide} flag=${+c.flag} waiting=${+c.waiting} held=${+c.held} read=${+c.read}`, c,
  ] as const))("%s", (_name, c) => {
    const a = computeAttention(build(c));
    const want = expected(c);
    expect(a.line.prefix).toBe(want.prefix);
    expect(a.line.primary.lane).toBe(want.primary);
    expect(a.line.summary.map((s) => s.lane)).toEqual(want.summary);
    // Never hidden: a failure always prefixes; a hold never covers Decide or Waiting.
    if (c.held && (c.decide || c.waiting)) expect(a.line.primary.lane).not.toBe("held");
    // Every non-empty lane is visible somewhere on the line.
    const shown = new Set<string>([a.line.primary.lane, ...a.line.summary.map((s) => s.lane)]);
    if (c.flag) expect(shown.has("flag") || shown.has("flags")).toBe(true);
    if (c.waiting) expect(shown.has("waiting")).toBe(true);
    if (c.held) expect(shown.has("held")).toBe(true);
    if (c.read) expect(shown.has("read")).toBe(true);
  });

  it("covers all 32 System×Decide×Flag×Waiting×Held combinations (×2 for Read)", () => {
    expect(new Set(combos.map((c) => `${c.failure}${c.decide}${c.flag}${c.waiting}${c.held}`)).size).toBe(32);
    expect(combos.length).toBe(64);
  });

  it("several failures at once: one prefix, in the fixed order (disconnected first, replay last)", () => {
    const a = computeAttention({ artifacts: [], system: { replay: true, staleDaemon: true, disconnected: true } });
    expect(a.line.prefix).toBe("disconnected");
    expect(computeAttention({ artifacts: [], system: { replay: true, staleDaemon: true } }).line.prefix).toBe("stale-daemon");
    expect(computeAttention({ artifacts: [], system: { replay: true } }).line.prefix).toBe("replay");
  });

  it("a possible-secret flag on a pending draft marks the Decide item and is counted as a flag — never a second Decide item", () => {
    seq = 0;
    const a = computeAttention({ artifacts: [art("plan", "draft", { id: "p", secretWarnings: [{ label: "k", line: 1 }] } as any)] });
    expect(a.lanes.decide.map((d) => d.id)).toEqual(["p"]);
    expect(a.next?.flags).toEqual(["possible-secret"]);
    expect(a.line.summary.map((s) => s.lane)).toEqual(["decide", "flags"]);
  });
});
