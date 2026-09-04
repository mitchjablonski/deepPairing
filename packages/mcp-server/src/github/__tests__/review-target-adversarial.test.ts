import { describe, expect, it } from "vitest";
import { parsePrRef, resolvePrTarget } from "../post-review.js";
import { parsePrNumber, samePrTarget, type PostedReviewRecord } from "../../store/posted-reviews.js";

describe("adversarial PR identity", () => {
  it.each(["42", " #42 ", "https://github.com/acme/widgets/pull/42", "https://github.com/acme/widgets/pull/42/files#diff-example"])(
    "keeps legitimate references consistent at both parsers: %s", ref => {
      expect(parsePrRef(ref)).toEqual(parsePrNumber(ref));
      expect(parsePrRef(ref).number).toBe(42);
    },
  );
  it.each([
    "https://notgithub.com/acme/widgets/pull/42",
    "https://evil.example/github.com/acme/widgets/pull/42",
    "https://github.com/acme/widgets/pull/42garbage",
    "https://github.com/acme/widgets/pull/42/../../43",
    "http://github.com/acme/widgets/pull/42",
    "0", "9007199254740993",
  ])("refuses ambiguous or untrusted references at both parsers: %s", ref => {
    expect(parsePrNumber(ref)).toBeNull();
    expect(() => parsePrRef(ref)).toThrow();
  });

  it("does not let capitalization bypass the posted-review guard", () => {
    const record: PostedReviewRecord = {
      pr: "42", prNumber: 42, owner: "acme", repo: "widgets", event: "APPROVE",
      reviewId: 1, url: "", postedAt: "2026-09-04T12:00:00Z", commentCount: 0,
    };
    expect(samePrTarget(record, "https://github.com/ACME/Widgets/pull/42")).toBe(true);
  });

  it.each([["acme/other", "widgets"], ["acme", "widgets?query"], ["", "widgets"]])(
    "rejects repository overrides that alter URL structure: %s %s", async (owner, repo) => {
      await expect(resolvePrTarget("https://github.com/acme/widgets/pull/42", owner, repo)).rejects.toThrow();
    },
  );
});
