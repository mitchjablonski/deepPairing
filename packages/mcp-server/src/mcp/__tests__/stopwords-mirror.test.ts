// #680 slice 4 — the shared stopword list (used by a page "Rule this out") is a
// mirror of the matcher's own list; the hook can't import shared, so the two
// copies are pinned equal here.
import { describe, it, expect } from "vitest";
import { SHORT_STOPWORDS as SHARED } from "@deeppairing/shared";
import { SHORT_STOPWORDS as MATCHER, meaningfulTokens } from "../preflight-validator.js";

describe("SHORT_STOPWORDS mirror", () => {
  it("the shared copy equals the matcher's list", () => {
    expect([...SHARED].sort()).toEqual([...MATCHER].sort());
  });
  it("shared contentTokens agrees with the matcher on which tokens count (pre-stem)", async () => {
    const { contentTokens } = await import("@deeppairing/shared");
    for (const s of ["of the", "Most of the handlers", "use the purge queue", "to be or not", "Up to 60s"]) {
      expect(contentTokens(s).length > 0, s).toBe(meaningfulTokens(s).length > 0);
    }
  });
});
