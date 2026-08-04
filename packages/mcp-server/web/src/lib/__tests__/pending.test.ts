import { describe, it, expect } from "vitest";
import { computePending, isDraftAwaitingReview, isUnresolvedQuestion, REVIEWABLE_TYPES, TURN_PART_BUCKETS, summarizeTurnParts } from "../pending";

const art = (over: any) =>
  ({ id: "a", type: "research", title: "t", status: "draft", version: 1, createdAt: "2026-01-01T00:00:00.000Z", content: {}, ...over }) as any;
const com = (over: any) =>
  ({ id: "c", sessionId: "s", target: { artifactId: "a" }, parentCommentId: null, author: "human", content: "x", acknowledged: false, createdAt: "2026-01-01T00:00:00.000Z", ...over }) as any;

describe("computePending — single source of truth for 'waiting on human'", () => {
  it("counts every draft reviewable artifact (incl. #190 debrief + explainer) but not reasoning", () => {
    const artifacts = [
      art({ id: "r", type: "research", status: "draft" }),
      art({ id: "p", type: "plan", status: "draft" }),
      art({ id: "d", type: "decision", status: "draft" }),
      art({ id: "cc", type: "code_change", status: "draft" }),
      art({ id: "spec", type: "spec", status: "draft" }),
      art({ id: "cs", type: "changeset", status: "draft" }), // #175 — a draft changeset awaits review
      art({ id: "db", type: "debrief", status: "draft" }), // #190 A1 — draft review surface
      art({ id: "ex", type: "explainer", status: "draft" }), // #190 A2 — draft review surface
      art({ id: "reason", type: "reasoning", status: "draft" }), // excluded (agent narration)
    ];
    const { drafts, total } = computePending(artifacts, {});
    expect(drafts.map((a) => a.id).sort()).toEqual(["cc", "cs", "d", "db", "ex", "p", "r", "spec"]);
    expect(total).toBe(8);
  });

  // #190 — a draft debrief/explainer renders the full Approve/Request-changes/
  // Reject triad and counts server-side; pre-fix REVIEWABLE_TYPES omitted BOTH,
  // so the in-app PendingBanner never lit for them (same class as the #175
  // changeset omission). These pin the predicate directly.
  it("treats a draft debrief and a draft explainer as awaiting review (#190)", () => {
    expect(isDraftAwaitingReview(art({ type: "debrief", status: "draft" }))).toBe(true);
    expect(isDraftAwaitingReview(art({ type: "explainer", status: "draft" }))).toBe(true);
    // Parity self-check within the web boundary: the reviewable set carries both.
    expect(REVIEWABLE_TYPES.has("debrief")).toBe(true);
    expect(REVIEWABLE_TYPES.has("explainer")).toBe(true);
    // reasoning stays excluded (agent narration, no review cycle).
    expect(REVIEWABLE_TYPES.has("reasoning")).toBe(false);
  });

  it("excludes non-draft artifacts (approved/obsolete/etc.)", () => {
    const artifacts = [
      art({ id: "a1", status: "approved" }),
      art({ id: "a2", status: "obsolete" }),
      art({ id: "a3", status: "rejected" }),
      art({ id: "a4", status: "draft" }),
    ];
    expect(computePending(artifacts, {}).drafts.map((a) => a.id)).toEqual(["a4"]);
  });

  it("does NOT count human-asked questions — that's the agent's turn, not yours", () => {
    const comments = {
      a: [
        com({ id: "q1", intent: "question" }), // unanswered human question → still NOT your turn
        com({ id: "q2", intent: "question", answeredByCommentId: "x" }),
        com({ id: "c1", intent: "comment" }),
      ],
    };
    expect(computePending([], comments).total).toBe(0);
  });

  it("total = drafts only (questions are excluded)", () => {
    const artifacts = [art({ id: "d", type: "decision", status: "draft" })];
    const comments = { d: [com({ id: "q", intent: "question" })] };
    expect(computePending(artifacts, comments).total).toBe(1);
  });

  it("predicate helpers are consistent with the aggregate", () => {
    expect(isDraftAwaitingReview(art({ type: "code_change", status: "draft" }))).toBe(true);
    expect(isDraftAwaitingReview(art({ type: "reasoning", status: "draft" }))).toBe(false);
    expect(isDraftAwaitingReview(art({ type: "plan", status: "approved" }))).toBe(false);
    expect(isUnresolvedQuestion(com({ intent: "question" }))).toBe(true);
    expect(isUnresolvedQuestion(com({ intent: "question", humanResolvedAt: "2026-01-02T00:00:00.000Z" }))).toBe(false);
  });
});

// #192 (usability H1) — the TurnIndicator "Your turn — …" summary. Pre-#192 it
// counted only research/spec, decision, code_change and plan, so with ONLY a
// changeset/debrief/explainer pending it rendered a dangling "Your turn —" while
// the tab badge said 3. This pins the bucket table against REVIEWABLE_TYPES (the
// class-ending parity guard, mirroring create-daemon's REVIEWABLE parity test)
// and the summary itself.
describe("#192 — summarizeTurnParts (every reviewable type produces a non-empty part)", () => {
  it("TURN_PART_BUCKETS covers EXACTLY the REVIEWABLE_TYPES set — no type can silently miss a bucket", () => {
    const bucketed = new Set(TURN_PART_BUCKETS.flatMap((b) => [...b.types]));
    expect(bucketed).toEqual(new Set(REVIEWABLE_TYPES));
  });

  it("produces a non-empty part for a draft of EVERY reviewable type", () => {
    for (const type of REVIEWABLE_TYPES) {
      const parts = summarizeTurnParts([art({ id: type, type, status: "draft" })]);
      expect(parts.length, `type ${type} produced no summary part`).toBeGreaterThan(0);
      expect(parts[0]).not.toMatch(/^\s*$/);
    }
  });

  it("counts changeset + debrief + explainer (the omitted three) rather than dropping them", () => {
    const parts = summarizeTurnParts([
      art({ id: "cs", type: "changeset", status: "draft" }),
      art({ id: "db", type: "debrief", status: "draft" }),
      art({ id: "ex", type: "explainer", status: "draft" }),
    ]);
    expect(parts).toEqual(["1 changeset", "1 debrief", "1 explainer"]);
  });

  it("pluralizes and groups research+spec into 'findings'", () => {
    const parts = summarizeTurnParts([
      art({ id: "r1", type: "research", status: "draft" }),
      art({ id: "s1", type: "spec", status: "draft" }),
      art({ id: "d1", type: "decision", status: "draft" }),
      art({ id: "d2", type: "decision", status: "draft" }),
    ]);
    expect(parts).toEqual(["2 findings", "2 decisions"]);
  });

  it("defensive fallback: a pending type NOT in any bucket still yields 'N items', never an empty list", () => {
    // Simulate a future reviewable type the bucket table hasn't caught up to.
    const parts = summarizeTurnParts([art({ id: "x", type: "brand_new_type", status: "draft" })]);
    expect(parts).toEqual(["1 item"]);
  });

  it("returns an empty list only when there is nothing pending", () => {
    expect(summarizeTurnParts([])).toEqual([]);
  });
});
