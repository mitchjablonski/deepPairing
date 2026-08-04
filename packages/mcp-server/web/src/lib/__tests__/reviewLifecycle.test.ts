import { describe, it, expect } from "vitest";
import { isLateCommentableStatus, type ArtifactStatus } from "@deeppairing/shared";
import { reviewLifecycle } from "../reviewLifecycle";

const ALL_STATUSES: ArtifactStatus[] = [
  "draft",
  "reviewing",
  "approved",
  "revised",
  "rejected",
  "superseded",
  "retracted",
  "obsolete",
];

describe("#189 reviewLifecycle — the write-axis helper", () => {
  it("replay ALWAYS wins → frozen, for every status", () => {
    for (const status of ALL_STATUSES) {
      expect(reviewLifecycle(status, true)).toBe("frozen");
    }
  });

  it("draft (live) → review", () => {
    expect(reviewLifecycle("draft", false)).toBe("review");
  });

  it("approved (live, the only late-commentable status) → follow_up", () => {
    expect(reviewLifecycle("approved", false)).toBe("follow_up");
  });

  it("every other terminal/non-draft status (live) → closed", () => {
    for (const status of ALL_STATUSES) {
      if (status === "draft" || status === "approved") continue;
      expect(reviewLifecycle(status, false)).toBe("closed");
    }
  });
});

/**
 * The refactor MUST be byte-identical: the ChangesetArtifact write-gating tuple
 * used to be spelled out as three inline booleans. Re-derive them from the
 * lifecycle and compare against the ORIGINAL formulas across the full
 * status × replay matrix — any drift fails here, not in a screenshot.
 */
describe("#189 reviewLifecycle — gating parity with the pre-refactor booleans", () => {
  it("reviewActive / commentsUnlocked / followUpLane are unchanged for all (status, replay)", () => {
    for (const status of ALL_STATUSES) {
      for (const replayActive of [false, true]) {
        // ORIGINAL inline formulas (ChangesetArtifact, pre-#189):
        const oldReviewActive = status === "draft" && !replayActive;
        const oldCommentsUnlocked =
          !replayActive && (status === "draft" || isLateCommentableStatus(status));
        const oldFollowUpLane = oldCommentsUnlocked && !oldReviewActive;

        // Derived from the shared helper:
        const lifecycle = reviewLifecycle(status, replayActive);
        const newReviewActive = lifecycle === "review";
        const newCommentsUnlocked = lifecycle === "review" || lifecycle === "follow_up";
        const newFollowUpLane = lifecycle === "follow_up";

        expect(newReviewActive, `reviewActive ${status}/${replayActive}`).toBe(oldReviewActive);
        expect(newCommentsUnlocked, `commentsUnlocked ${status}/${replayActive}`).toBe(oldCommentsUnlocked);
        expect(newFollowUpLane, `followUpLane ${status}/${replayActive}`).toBe(oldFollowUpLane);
      }
    }
  });
});
