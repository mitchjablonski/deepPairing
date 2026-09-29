import { describe, it, expect } from "vitest";
import type { Artifact, Comment, Request } from "@deeppairing/shared";
import { countUnansweredQuestions } from "@deeppairing/shared";
import { computeAttention, type AttentionInput, type SummaryLane } from "../attention";
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

  it.each([
    // #430 PR 1c (review of #448) — consecutive questions in ONE thread, so the
    // parity claim holds beyond one-question threads.
    ["A: Q1 then an open follow-up Q2", [["q1"], ["q2", { parentCommentId: "q1" }]], ["q1", "q2"]],
    ["B: Q1 then a human-resolved follow-up Q2", [["q1"], ["q2", { parentCommentId: "q1", humanResolvedAt: "2026-06-01T01:00:00.000Z" }]], ["q1"]],
    ["C: an agent reply after both", [["q1"], ["q2", { parentCommentId: "q1" }], ["r", { parentCommentId: "q2", author: "agent", intent: undefined }]], []],
  ] as const)("Waiting questions == countUnansweredQuestions — %s", (_name, spec, open) => {
    seq = 0;
    const list = spec.map(([id, over]) => question(id, "a1", (over ?? {}) as Partial<Comment>));
    const a = computeAttention({ artifacts: [], comments: { a1: list } });
    const questions = a.lanes.waiting.filter((w) => w.kind === "question");
    expect(questions.length).toBe(countUnansweredQuestions(list));
    expect(questions.map((q) => q.id).sort()).toEqual([...open]);
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

describe("§4.3 worked table — the doc's rows, literally", () => {
  // Test-side RENDERER only: maps the selector's structured line to the doc's
  // tokens one-to-one. It makes no precedence decisions — every expected string
  // below is copied from docs/design/attention-hierarchy.md §4.3's worked table
  // (with the doc's "…" / "<artifact>" / "next" placeholders filled in).
  const PREFIX: Record<string, string> = {
    disconnected: "⚠ DISCONNECTED", "stale-daemon": "⚠ STALE DAEMON", replay: "REPLAY",
    "session-conflict": "⚠ SESSION CONFLICT", "snapshot-unavailable": "⚠ SNAPSHOT UNAVAILABLE",
  };
  const SUMMARY: Record<SummaryLane, (n: number) => string> = {
    "high-decision": (n) => `+${n} high decision`, decide: (n) => `Decide ${n}`, flags: (n) => `⚠ flags ${n}`,
    waiting: (n) => `Waiting ${n}`, held: (n) => `Held ${n}`, read: (n) => `Read ${n}`,
  };
  function render(input: AttentionInput): string {
    const { line } = computeAttention(input);
    const p = line.primary;
    const primary =
      p.lane === "decide" ? `▲ ${p.item!.title}`
      : p.lane === "flag" ? `⚠ Possible secret in ${p.item!.title}`
      : p.lane === "waiting" ? "◌ WAITING ON CLAUDE"
      : p.lane === "held" ? "■ HELD"
      : "○ Nothing needs you";
    return [line.prefix ? PREFIX[line.prefix] : null, primary, ...line.summary.map((x) => SUMMARY[x.lane](x.count))]
      .filter(Boolean)
      .join(" · ");
  }

  // Every lane that is present holds TWO items, so the summary counts are real.
  type State = {
    failure?: "disconnected" | "staleDaemon" | "replay";
    decide?: boolean; flag?: boolean; waiting?: boolean; held?: boolean; read?: boolean;
  };
  function state(st: State): AttentionInput {
    seq = 0;
    const artifacts: Artifact[] = [];
    if (st.decide) {
      artifacts.push(art("research", "draft", { id: "d1", title: "Oldest finding" }));
      artifacts.push(art("decision", "draft", { id: "d2", title: "Store choice", content: { stakes: "high" } }));
      artifacts.push(art("plan", "draft", { id: "d3", title: "Rollout plan" }));
    }
    if (st.flag) {
      artifacts.push(art("research", "approved", { id: "s1", title: "Config dump", secretWarnings: [{ label: "k", line: 1 }] } as any));
      artifacts.push(art("spec", "superseded", { id: "s2", title: "Old spec", secretWarnings: [{ label: "k", line: 2 }] } as any));
    }
    if (st.read) {
      artifacts.push(art("explainer", "draft", { id: "e1" }));
      artifacts.push(art("reasoning", "draft", { id: "e2" }));
    }
    const comments: Record<string, Comment[]> = st.waiting ? { a: [question("q1", "a")], b: [question("q2", "b")] } : {};
    const holds = st.held ? [{ id: "h1", title: "held one", at: ts() }, { id: "h2", title: "held two", at: ts() }] : [];
    return { artifacts, comments, system: { ...(st.failure ? { [st.failure]: true } : {}), holds } };
  }

  // [doc row, state, exact line]. "any" rows are instantiated with the lanes PRESENT.
  const ROWS: [string, State, string][] = [
    ["— ✓ any any any", { decide: true, flag: true, waiting: true, held: true, read: true },
      "▲ Oldest finding · +1 high decision · Decide 3 · ⚠ flags 2 · Waiting 2 · Held 2 · Read 2"],
    ["✓ ✓ any any any", { failure: "disconnected", decide: true, flag: true, waiting: true, held: true, read: true },
      "⚠ DISCONNECTED · ▲ Oldest finding · +1 high decision · Decide 3 · ⚠ flags 2 · Waiting 2 · Held 2 · Read 2"],
    ["— — ✓ any any", { flag: true, waiting: true, held: true, read: true },
      "⚠ Possible secret in Config dump · Waiting 2 · Held 2 · Read 2"],
    ["✓ — ✓ any any", { failure: "staleDaemon", flag: true, waiting: true, held: true, read: true },
      "⚠ STALE DAEMON · ⚠ Possible secret in Config dump · Waiting 2 · Held 2 · Read 2"],
    ["— — — ✓ —", { waiting: true, read: true }, "◌ WAITING ON CLAUDE · Read 2"],
    ["— — — ✓ ✓", { waiting: true, held: true, read: true }, "◌ WAITING ON CLAUDE · Held 2 · Read 2"],
    ["✓ — — ✓ any", { failure: "disconnected", waiting: true, held: true, read: true },
      "⚠ DISCONNECTED · ◌ WAITING ON CLAUDE · Held 2 · Read 2"],
    ["— — — — ✓", { held: true, read: true }, "■ HELD · Read 2"],
    ["✓ — — — ✓", { failure: "replay", held: true, read: true }, "REPLAY · ■ HELD · Read 2"],
    ["— — — — —", { read: true }, "○ Nothing needs you · Read 2"],
    ["✓ — — — —", { failure: "disconnected", read: true }, "⚠ DISCONNECTED · ○ Nothing needs you · Read 2"],
    // "Read is shown only when non-empty".
    ["— — — — — (no Read)", {}, "○ Nothing needs you"],
  ];

  it.each(ROWS)("doc row %s", (_row, st, line) => {
    expect(render(state(st))).toBe(line);
  });

  it("'+N high decision' is absent when `next` is the only high-stakes decision", () => {
    seq = 0;
    const input: AttentionInput = { artifacts: [
      art("decision", "draft", { id: "only", title: "Store choice", content: { stakes: "high" } }),
      art("research", "draft", { id: "later", title: "A later finding" }),
    ] };
    expect(render(input)).toBe("▲ Store choice · Decide 2");
  });
});

describe("§4.3 invariants over all 32 System × Decide × Flag × Waiting × Held combinations (× Read)", () => {
  type Combo = { failure: boolean; decide: boolean; flag: boolean; waiting: boolean; held: boolean; read: boolean };
  const combos: Combo[] = [];
  for (let m = 0; m < 64; m++) {
    combos.push({ failure: !!(m & 1), decide: !!(m & 2), flag: !!(m & 4), waiting: !!(m & 8), held: !!(m & 16), read: !!(m & 32) });
  }
  const FAILURES = ["disconnected", "staleDaemon", "replay"] as const;
  function build(c: Combo, k: number): AttentionInput {
    seq = 0;
    const artifacts: Artifact[] = [];
    if (c.decide) artifacts.push(art("research", "draft", { id: "dec1" }), art("decision", "draft", { id: "dec2", content: { stakes: "high" } }));
    if (c.flag) artifacts.push(art("research", "approved", { id: "sec", secretWarnings: [{ label: "k", line: 1 }] } as any));
    if (c.read) artifacts.push(art("explainer", "draft", { id: "exp" }));
    return {
      artifacts,
      comments: c.waiting ? { a: [question("q", "a")] } : {},
      system: { ...(c.failure ? { [FAILURES[k % 3]!]: true } : {}), holds: c.held ? [{ id: "h", title: "held", at: ts() }] : [] },
    };
  }
  const ORDER: SummaryLane[] = ["high-decision", "decide", "flags", "waiting", "held", "read"];

  it("covers all 32 combinations (×2 for Read)", () => {
    expect(new Set(combos.map((c) => `${c.failure}${c.decide}${c.flag}${c.waiting}${c.held}`)).size).toBe(32);
  });

  it.each(combos.map((c, k) => [
    `failure=${+c.failure} decide=${+c.decide} flag=${+c.flag} waiting=${+c.waiting} held=${+c.held} read=${+c.read}`, c, k,
  ] as const))("%s", (_name, c, k) => {
    const { line } = computeAttention(build(c, k));
    const shown = new Set<string>([line.primary.lane, ...line.summary.map((s) => s.lane)]);
    // A failure prefix is present iff there is a System failure.
    expect(line.prefix !== null).toBe(c.failure);
    // Owed-by-you work is never covered: Decide, when present, is primary.
    expect(line.primary.lane === "decide").toBe(c.decide);
    // A hold is never primary while Decide or Waiting is non-empty; a flag never while Decide is.
    if (c.decide || c.waiting) expect(line.primary.lane).not.toBe("held");
    if (c.decide) expect(line.primary.lane).not.toBe("flag");
    // Nothing needs you ⇔ nothing is owed, flagged, waiting or held.
    expect(line.primary.lane === "nothing").toBe(!c.decide && !c.flag && !c.waiting && !c.held);
    // Every non-empty lane is visible somewhere on the line; no empty lane is.
    expect(shown.has("flag") || shown.has("flags")).toBe(c.flag);
    expect(shown.has("waiting")).toBe(c.waiting);
    expect(shown.has("held")).toBe(c.held);
    expect(shown.has("read")).toBe(c.read);
    // The summary never repeats a lane and keeps the fixed order.
    const lanes = line.summary.map((s) => s.lane);
    expect(lanes).toEqual([...lanes].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
    expect(new Set(lanes).size).toBe(lanes.length);
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
