import { describe, it, expect } from "vitest";
import { computePending, isDraftAwaitingReview, isSinglePendingInView, isUnresolvedQuestion, REVIEWABLE_TYPES, TURN_PART_BUCKETS, summarizeTurnParts } from "../pending";

const art = (over: any) =>
  ({ id: "a", type: "research", title: "t", status: "draft", version: 1, createdAt: "2026-01-01T00:00:00.000Z", content: {}, ...over }) as any;
const com = (over: any) =>
  ({ id: "c", sessionId: "s", target: { artifactId: "a" }, parentCommentId: null, author: "human", content: "x", acknowledged: false, createdAt: "2026-01-01T00:00:00.000Z", ...over }) as any;

describe("computePending — single source of truth for 'waiting on human'", () => {
  it("counts every draft reviewable artifact (incl. #190 debrief) but not reasoning or an explainer", () => {
    const artifacts = [
      art({ id: "r", type: "research", status: "draft" }),
      art({ id: "p", type: "plan", status: "draft" }),
      art({ id: "d", type: "decision", status: "draft" }),
      art({ id: "cc", type: "code_change", status: "draft" }),
      art({ id: "spec", type: "spec", status: "draft" }),
      art({ id: "cs", type: "changeset", status: "draft" }), // #175 — a draft changeset awaits review
      art({ id: "db", type: "debrief", status: "draft" }), // #190 A1 — draft review surface
      art({ id: "ex", type: "explainer", status: "draft" }), // P3 — acknowledge-only, NOT pending
      art({ id: "reason", type: "reasoning", status: "draft" }), // excluded (agent narration)
    ];
    const { drafts, total } = computePending(artifacts, {});
    expect(drafts.map((a) => a.id).sort()).toEqual(["cc", "cs", "d", "db", "p", "r", "spec"]);
    expect(total).toBe(7);
  });

  // #190 — a draft debrief renders the full Approve/Request-changes/Reject triad
  // and counts server-side; pre-fix REVIEWABLE_TYPES omitted it, so the in-app
  // PendingBanner never lit for it (same class as the #175 changeset omission).
  // P3 — the EXPLAINER is the counterpart correction: it is acknowledge-only
  // ("Got it" / "Ask more" — no verdict), so a "waiting on you" badge lit on it
  // overstated the obligation. It is delivered to the agent under check_feedback's
  // "TO READ" line instead of being counted pending anywhere.
  it("treats a draft debrief as awaiting review (#190) but NOT a draft explainer (P3)", () => {
    expect(isDraftAwaitingReview(art({ type: "debrief", status: "draft" }))).toBe(true);
    expect(isDraftAwaitingReview(art({ type: "explainer", status: "draft" }))).toBe(false);
    // Parity self-check within the web boundary.
    expect(REVIEWABLE_TYPES.has("debrief")).toBe(true);
    expect(REVIEWABLE_TYPES.has("explainer")).toBe(false);
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

// #212 (J2b) — the lite-frame step-down predicate: suppress the PendingBanner
// (and collapse the header turn-pill to a count) ONLY when exactly one draft is
// pending AND it is the artifact in view. Conservative on every other shape.
describe("isSinglePendingInView — J2b lite-frame step-down rule", () => {
  const draft = (id: string) => art({ id, type: "code_change", status: "draft" });

  it("true when the one pending draft IS the selected/in-view artifact", () => {
    expect(isSinglePendingInView([draft("only")], "only")).toBe(true);
  });

  it("false when the single pending draft is NOT the one in view (banner is the scent)", () => {
    expect(isSinglePendingInView([draft("d1"), art({ id: "seen", status: "approved" })], "seen")).toBe(false);
  });

  it("false when nothing is selected (null/undefined)", () => {
    expect(isSinglePendingInView([draft("d1")], null)).toBe(false);
    expect(isSinglePendingInView([draft("d1")], undefined)).toBe(false);
  });

  it("false for 2+ pending drafts even if one of them is in view", () => {
    expect(isSinglePendingInView([draft("d1"), draft("d2")], "d1")).toBe(false);
  });

  it("false when there is nothing pending (a selected approved artifact isn't a draft)", () => {
    expect(isSinglePendingInView([art({ id: "a", status: "approved" })], "a")).toBe(false);
  });

  it("only DRAFT reviewables count — a selected reasoning artifact never triggers the step-down", () => {
    expect(isSinglePendingInView([art({ id: "r", type: "reasoning", status: "draft" })], "r")).toBe(false);
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

  it("counts changeset + debrief (the omitted two) rather than dropping them, and never an explainer", () => {
    const parts = summarizeTurnParts([
      art({ id: "cs", type: "changeset", status: "draft" }),
      art({ id: "db", type: "debrief", status: "draft" }),
      // P3 — an explainer is not "your turn" work; it must not appear in the
      // summary (and must not resurrect the dangling-dash bug on its own).
      art({ id: "ex", type: "explainer", status: "draft" }),
    ]);
    expect(parts).toEqual(["1 changeset", "1 debrief"]);
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
