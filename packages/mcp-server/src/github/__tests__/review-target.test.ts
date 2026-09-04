import { describe, it, expect } from "vitest";
import { authorizeReviewPost, type AuthorizableSession } from "../review-authorization.js";

function state(url?: string): AuthorizableSession {
  return { sessionId: "s", decisions: [], comments: [], planReviews: [], preferences: {}, artifacts: [{
    id: "a", sessionId: "s", type: "changeset", title: "Reviewed change", status: "approved", version: 1,
    parentId: null, agentReasoning: null, createdAt: "2026-09-04T12:00:00Z", updatedAt: "2026-09-04T12:00:00Z",
    content: { summary: "Reviewed", files: [], reviewIntent: "external", source: { kind: "github-pr", number: 123, ...(url ? { url } : {}) } },
  }] };
}

describe("PR approval target", () => {
  const source = "https://github.com/acme/widgets/pull/123";
  it.each(["https://github.com/acme/widgets/pull/999", "https://github.com/other/widgets/pull/123", "https://github.com/acme/other/pull/123"])("rejects a different target: %s", pr => {
    const result = authorizeReviewPost(state(source), { event: "APPROVE", pr });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("requested PR");
  });
  it("requires repository provenance even when the number matches", () => {
    expect(authorizeReviewPost(state(), { event: "APPROVE", pr: source }).ok).toBe(false);
  });
  it("accepts the reviewed target, including case-insensitive repository names", () => {
    expect(authorizeReviewPost(state(source), { event: "APPROVE", pr: "https://github.com/ACME/Widgets/pull/123" }).ok).toBe(true);
  });
});
