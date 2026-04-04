import { describe, it, expect } from "vitest";
import { ReasoningTracker } from "../reasoning-tracker.js";

describe("ReasoningTracker", () => {
  it("returns false when no reasoning has been logged", () => {
    const tracker = new ReasoningTracker();
    expect(tracker.hasRecentReasoning("session_1")).toBe(false);
  });

  it("returns true immediately after recording reasoning", () => {
    const tracker = new ReasoningTracker();
    tracker.recordReasoning("session_1");
    expect(tracker.hasRecentReasoning("session_1")).toBe(true);
  });

  it("remains true after a few tool calls", () => {
    const tracker = new ReasoningTracker(5);
    tracker.recordReasoning("session_1");
    tracker.recordToolCall("session_1");
    tracker.recordToolCall("session_1");
    tracker.recordToolCall("session_1");
    expect(tracker.hasRecentReasoning("session_1")).toBe(true);
  });

  it("expires after maxCallsBeforeExpiry tool calls", () => {
    const tracker = new ReasoningTracker(3);
    tracker.recordReasoning("session_1");
    tracker.recordToolCall("session_1");
    tracker.recordToolCall("session_1");
    tracker.recordToolCall("session_1"); // 3rd call → expires
    expect(tracker.hasRecentReasoning("session_1")).toBe(false);
  });

  it("resets counter when reasoning is logged again", () => {
    const tracker = new ReasoningTracker(2);
    tracker.recordReasoning("session_1");
    tracker.recordToolCall("session_1");
    tracker.recordToolCall("session_1"); // expired
    expect(tracker.hasRecentReasoning("session_1")).toBe(false);

    tracker.recordReasoning("session_1"); // re-record
    expect(tracker.hasRecentReasoning("session_1")).toBe(true);
  });

  it("tracks sessions independently", () => {
    const tracker = new ReasoningTracker();
    tracker.recordReasoning("session_a");
    expect(tracker.hasRecentReasoning("session_a")).toBe(true);
    expect(tracker.hasRecentReasoning("session_b")).toBe(false);
  });

  it("ignores tool calls for sessions without recorded reasoning", () => {
    const tracker = new ReasoningTracker();
    tracker.recordToolCall("session_1"); // no reasoning logged yet
    tracker.recordToolCall("session_1");
    expect(tracker.hasRecentReasoning("session_1")).toBe(false);
  });

  it("clears tracking for a session", () => {
    const tracker = new ReasoningTracker();
    tracker.recordReasoning("session_1");
    expect(tracker.hasRecentReasoning("session_1")).toBe(true);

    tracker.clear("session_1");
    expect(tracker.hasRecentReasoning("session_1")).toBe(false);
  });
});
