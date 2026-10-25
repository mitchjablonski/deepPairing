import { describe, it, expect } from "vitest";
import { isDemoSessionId, KNOWN_SAMPLE_SESSION_IDS } from "../session-provenance.js";

describe("isDemoSessionId (#569 proposal 1)", () => {
  it("flags daemon-minted demo sessions by their demo_ prefix", () => {
    expect(isDemoSessionId("demo_1729800000000")).toBe(true);
    expect(isDemoSessionId("DEMO_abc")).toBe(true);
  });

  it("flags the repo's own checked-in sample sessions by exact id", () => {
    for (const id of KNOWN_SAMPLE_SESSION_IDS) expect(isDemoSessionId(id)).toBe(true);
  });

  it("treats every other id — including legacy and test-looking ones — as real work", () => {
    for (const id of ["sess_1", "test_flaky_retry", "fixture-run", "my-demo", "b-demo-2", "0b9c-uuid"]) {
      expect(isDemoSessionId(id)).toBe(false);
    }
  });

  it("treats a missing id as real (not demo)", () => {
    expect(isDemoSessionId(null)).toBe(false);
    expect(isDemoSessionId(undefined)).toBe(false);
    expect(isDemoSessionId("")).toBe(false);
  });
});
