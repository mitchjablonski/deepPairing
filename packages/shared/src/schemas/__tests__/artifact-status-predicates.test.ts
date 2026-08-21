/**
 * R3 — the closed-status question, answered once.
 *
 * Round 13 counted eight hand-copies of "is this artifact closed?" across the
 * codebase under six names giving three different answers. Two of them were the
 * EXPORTERS, four files apart, asking the same question about the same artifact
 * and disagreeing: format-markdown's copy omitted `obsolete`, so overtaken work
 * shipped into PR descriptions and ADRs reading exactly like work that landed.
 *
 * These pin the three DISTINCT questions apart, because the copies existed
 * partly because nobody had written down that they were different questions.
 */
import { describe, it, expect } from "vitest";
import {
  isClosedArtifactStatus,
  isNeverApprovedStatus,
  isNotShippedStatus,
} from "../../index.js";

const ALL_STATUSES = [
  "draft",
  "reviewing",
  "approved",
  "revised",
  "rejected",
  "superseded",
  "retracted",
  "obsolete",
] as const;

describe("isNotShippedStatus — did this work ship?", () => {
  it("claims exactly the four discarded statuses", () => {
    const notShipped = ALL_STATUSES.filter(isNotShippedStatus);
    expect(notShipped).toEqual(["rejected", "superseded", "retracted", "obsolete"]);
  });

  // The bug this predicate exists to end.
  it("includes obsolete — the entry format-markdown's hand-copy dropped", () => {
    expect(isNotShippedStatus("obsolete")).toBe(true);
  });

  it("never claims approved work", () => {
    expect(isNotShippedStatus("approved")).toBe(false);
  });

  it("never claims work that simply has no verdict yet", () => {
    expect(isNotShippedStatus("draft")).toBe(false);
    expect(isNotShippedStatus("reviewing")).toBe(false);
    expect(isNotShippedStatus("revised")).toBe(false);
  });

  it("refuses to classify what it doesn't recognise", () => {
    expect(isNotShippedStatus(undefined)).toBe(false);
    expect(isNotShippedStatus("something_new")).toBe(false);
  });
});

describe("isNeverApprovedStatus — did anyone sign off on this?", () => {
  it("claims exactly the three no-verdict-yet statuses", () => {
    expect(ALL_STATUSES.filter(isNeverApprovedStatus)).toEqual(["draft", "reviewing", "revised"]);
  });

  it("is disjoint from isNotShippedStatus — a strike and a 'nobody read it' are different claims", () => {
    for (const s of ALL_STATUSES) {
      expect(isNeverApprovedStatus(s) && isNotShippedStatus(s)).toBe(false);
    }
  });

  it("refuses to classify what it doesn't recognise", () => {
    expect(isNeverApprovedStatus(undefined)).toBe(false);
    expect(isNeverApprovedStatus("something_new")).toBe(false);
  });
});

describe("the three questions are genuinely different", () => {
  // isClosedArtifactStatus asks "can the human still act on this?" and answers
  // YES-it's-closed for `approved`, the happiest outcome there is. Folding the
  // two together is how the hand-copies started.
  it("only isClosedArtifactStatus counts approved", () => {
    expect(isClosedArtifactStatus("approved")).toBe(true);
    expect(isNotShippedStatus("approved")).toBe(false);
    expect(isNeverApprovedStatus("approved")).toBe(false);
  });

  it("every status is answered by exactly one of the two export predicates, or neither", () => {
    const unclassified = ALL_STATUSES.filter((s) => !isNotShippedStatus(s) && !isNeverApprovedStatus(s));
    expect(unclassified).toEqual(["approved"]);
  });
});
