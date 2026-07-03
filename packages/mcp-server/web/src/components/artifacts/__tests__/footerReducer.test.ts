/**
 * E6 — the footer state machine's cross-state rules, tested as pure
 * transitions (they used to live in three separate effects + a duplicated
 * cancel function; regressions here were only catchable via full renders).
 */
import { describe, it, expect } from "vitest";
import { footerReducer, INITIAL_FOOTER_STATE } from "../ArtifactStatusActions";

const armed = footerReducer(INITIAL_FOOTER_STATE, { type: "armCountdown", seconds: 10 });

describe("E6 — footerReducer", () => {
  it("arming sets countdown/max and un-pauses (a prior cancel left paused=true)", () => {
    const cancelledFirst = footerReducer(armed, { type: "cancelCountdown" });
    expect(cancelledFirst.countdownPaused).toBe(true);
    const rearmed = footerReducer(cancelledFirst, { type: "armCountdown", seconds: 3 });
    expect(rearmed).toMatchObject({ countdown: 3, countdownMax: 3, countdownPaused: false });
  });

  it("typing cancels an armed countdown (was a dedicated effect)", () => {
    const s = footerReducer(armed, { type: "typed", comment: "wait" });
    expect(s.comment).toBe("wait");
    expect(s.countdown).toBeNull();
    expect(s.countdownPaused).toBe(true);
  });

  it("typing with NO countdown armed is a plain comment update", () => {
    const s = footerReducer(INITIAL_FOOTER_STATE, { type: "typed", comment: "hi" });
    expect(s).toMatchObject({ comment: "hi", countdownPaused: false });
  });

  it("every cancellation shares the B7 engagement semantics (un-collapse)", () => {
    const minimized = footerReducer(armed, { type: "minimize" });
    for (const action of [
      { type: "cancelCountdown" } as const,
      { type: "typed", comment: "x" } as const,
      { type: "submitStart" } as const,
      { type: "beginReject", concept: "c" } as const,
    ]) {
      const s = footerReducer(minimized, action);
      expect(s.userCollapsed, action.type).toBe(false);
      expect(s.countdown, action.type).toBeNull();
    }
  });

  it("B7' — reaching the end clears a manual Minimize; leaving it does not re-collapse", () => {
    const minimized = footerReducer(INITIAL_FOOTER_STATE, { type: "minimize" });
    const away = footerReducer(minimized, { type: "sentinel", atEnd: false });
    expect(away.userCollapsed).toBe(true); // still minimized while scrolled away
    const back = footerReducer(away, { type: "sentinel", atEnd: true });
    expect(back).toMatchObject({ atEnd: true, userCollapsed: false });
  });

  it("actionSucceeded clears comment + reject state but never mid-flight submitting", () => {
    let s = footerReducer(INITIAL_FOOTER_STATE, { type: "typed", comment: "reason" });
    s = footerReducer(s, { type: "beginReject", concept: "global state" });
    s = footerReducer(s, { type: "submitStart" });
    s = footerReducer(s, { type: "actionSucceeded" });
    expect(s).toMatchObject({ comment: "", rejecting: false, rejectConcept: "", submitting: true });
    s = footerReducer(s, { type: "submitEnd" });
    expect(s.submitting).toBe(false);
  });

  it("tick floors at disarmed (null stays null)", () => {
    expect(footerReducer(INITIAL_FOOTER_STATE, { type: "tick" }).countdown).toBeNull();
    expect(footerReducer(armed, { type: "tick" }).countdown).toBe(9);
  });
});

describe("E6 review — Respond vs terminal-action clearing", () => {
  it("respondSucceeded keeps an open reject panel + the edited concept (a clarifying comment must not discard the ledger key)", () => {
    let s = footerReducer(INITIAL_FOOTER_STATE, { type: "typed", comment: "reason" });
    s = footerReducer(s, { type: "beginReject", concept: "agent's phrasing" });
    s = footerReducer(s, { type: "rejectConceptTyped", concept: "my phrasing" });
    s = footerReducer(s, { type: "respondSucceeded" });
    expect(s).toMatchObject({ comment: "", rejecting: true, rejectConcept: "my phrasing" });
  });

  it("rejectConceptTyped is JUST typing — no cancel side effects", () => {
    const minimized = footerReducer(INITIAL_FOOTER_STATE, { type: "minimize" });
    const s = footerReducer(minimized, { type: "rejectConceptTyped", concept: "x" });
    expect(s.userCollapsed).toBe(true); // unlike the cancel paths
    expect(s.rejectConcept).toBe("x");
  });

  it("duplicate sentinel notifications bail out (a re-notify must not clear a Minimize)", () => {
    const minimizedAtEnd = footerReducer(INITIAL_FOOTER_STATE, { type: "minimize" });
    const dup = footerReducer(minimizedAtEnd, { type: "sentinel", atEnd: true }); // atEnd already true initially
    expect(dup).toBe(minimizedAtEnd); // same reference — no render minted
  });
});
