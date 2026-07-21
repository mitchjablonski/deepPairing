/**
 * #175 — the shared changeset-review helpers used by BOTH the companion UI (to
 * fire the send-back) and the check_feedback wire-shape test (to verify the
 * exact "which files + why" that reaches the agent).
 */
import { describe, it, expect } from "vitest";
import { composeSendBackFeedback, deriveChangesetDisposition } from "../changeset-review.js";

describe("deriveChangesetDisposition", () => {
  it("maps reviewed / needs_changes straight through", () => {
    const rs = { "a.ts": "reviewed", "b.ts": "needs_changes" } as const;
    expect(deriveChangesetDisposition(rs, "a.ts")).toBe("reviewed");
    expect(deriveChangesetDisposition(rs, "b.ts")).toBe("needs_changes");
  });

  it("maps a LEGACY 'skipped' and any absent path to pending", () => {
    // Skipping was never a real 'yes' — an old changeset must be re-reviewed,
    // not silently unlock approval.
    expect(deriveChangesetDisposition({ "a.ts": "skipped" }, "a.ts")).toBe("pending");
    expect(deriveChangesetDisposition({}, "a.ts")).toBe("pending");
    expect(deriveChangesetDisposition(undefined, "a.ts")).toBe("pending");
  });
});

describe("composeSendBackFeedback", () => {
  it("names ONLY the flagged files, each with its reason", () => {
    const out = composeSendBackFeedback(
      ["routes/login.ts", "auth/session.ts"],
      { "routes/login.ts": "keep the TTL bump", "auth/session.ts": "widen the type", "auth/other.ts": "not flagged" },
    );
    expect(out).toContain("Please revise 2 files");
    expect(out).toContain("- routes/login.ts: keep the TTL bump");
    expect(out).toContain("- auth/session.ts: widen the type");
    // A file that isn't in the flagged list never leaks in.
    expect(out).not.toContain("auth/other.ts");
  });

  it("singular header + a placeholder when a flagged file has no reason", () => {
    const out = composeSendBackFeedback(["a.ts"], {});
    expect(out).toContain("Please revise 1 file");
    expect(out).toContain("- a.ts: (no reason given)");
  });

  it("returns empty when nothing is flagged", () => {
    expect(composeSendBackFeedback([], { "a.ts": "x" })).toBe("");
    expect(composeSendBackFeedback([""], {})).toBe("");
  });
});
