/**
 * #680 slice 2 — the one predicate that decides whether a comment is listed by
 * the page renderer (and therefore left out of the general Comments history).
 * A comment is hidden from general history ONLY when the page list shows it.
 */
import { describe, it, expect } from "vitest";
import type { Comment } from "@deeppairing/shared";
import { isPageListedComment, isWellFormedHtmlAnchor } from "../htmlAnchorDisplay";

const anchor = { kind: "cell" as const, locator: "td", quote: "None", table: { row: "TTL", col: "Staleness" } };
function comment(target: Record<string, unknown>, parentCommentId: string | null = null): Comment {
  return {
    id: "c1",
    sessionId: "s1",
    target: { artifactId: "art_1", ...target } as Comment["target"],
    parentCommentId,
    author: "human",
    content: "x",
    acknowledged: false,
    createdAt: "2026-11-21T00:00:00.000Z",
  };
}

describe("isPageListedComment", () => {
  it("lists a root comment with a well-formed anchor on a page", () => {
    expect(isPageListedComment("page", comment({ htmlAnchor: anchor }))).toBe(true);
  });

  it("keeps a stray anchor on a non-page artifact in general history", () => {
    for (const type of ["plan", "decision", "changeset", "research"]) {
      expect(isPageListedComment(type, comment({ htmlAnchor: anchor })), type).toBe(false);
    }
  });

  it("keeps a malformed historical anchor in general history", () => {
    expect(isPageListedComment("page", comment({ htmlAnchor: { kind: "region", locator: "td", quote: "x" } }))).toBe(false);
    expect(isPageListedComment("page", comment({ htmlAnchor: { kind: "cell", quote: "x" } }))).toBe(false);
    expect(isPageListedComment("page", comment({ htmlAnchor: "td" }))).toBe(false);
  });

  it("keeps replies and plain comments in general history", () => {
    expect(isPageListedComment("page", comment({ htmlAnchor: anchor }, "cmt_root"))).toBe(false);
    expect(isPageListedComment("page", comment({}))).toBe(false);
  });

  it("a comment carried from an earlier page version (chain) is listed on the current page", () => {
    // useChainComments aggregates v1's comments onto v2; the target artifactId is v1's.
    expect(isPageListedComment("page", comment({ artifactId: "art_page_v1", htmlAnchor: anchor }))).toBe(true);
  });
});

describe("isWellFormedHtmlAnchor", () => {
  it("accepts every kind and rejects wrong field types", () => {
    for (const kind of ["element", "text", "cell", "diagram-node", "link"]) {
      expect(isWellFormedHtmlAnchor({ kind, locator: "x", quote: "" }), kind).toBe(true);
    }
    expect(isWellFormedHtmlAnchor({ kind: "link", locator: "x", quote: "", href: 5 })).toBe(false);
    expect(isWellFormedHtmlAnchor({ kind: "cell", locator: "x", quote: "", table: "row" })).toBe(false);
    expect(isWellFormedHtmlAnchor(null)).toBe(false);
  });
});
