/**
 * #680 slice 2 — the `htmlAnchor` comment target: accepted shapes, rejected
 * shapes (wrong kind, over-length fields, href on a non-link, empty text quote),
 * the HTTP body refinement, and the store sanitiser.
 */
import { describe, it, expect } from "vitest";
import {
  HtmlAnchorSchema,
  HTML_ANCHOR_LIMITS,
  CommentTargetSchema,
  sanitizeHtmlAnchor,
} from "../comment.js";
import { CommentBodySchema } from "../request-bodies.js";

const cell = {
  kind: "cell",
  locator: "table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)",
  quote: "Up to 60s",
  table: { row: "TTL expiry", col: "Staleness" },
  version: 1,
};

describe("HtmlAnchorSchema — accepts", () => {
  it.each([
    ["element", { kind: "element", locator: "#summary", quote: "Pick one of three strategies" }],
    ["text", { kind: "text", locator: "p:nth-of-type(1)", quote: "three strategies", prefix: "pick one of", suffix: "for the session" }],
    ["cell", cell],
    ["diagram-node", { kind: "diagram-node", locator: "#flowchart-AuthGate-1", quote: "AuthGate", nodeId: "AuthGate" }],
    ["link", { kind: "link", locator: "a:nth-of-type(1)", quote: "the RFC", href: "https://example.com/rfc" }],
  ])("a %s anchor", (_kind, anchor) => {
    expect(HtmlAnchorSchema.safeParse(anchor).success).toBe(true);
  });

  it("an element anchor with no text (an image) — empty quote is fine", () => {
    expect(HtmlAnchorSchema.safeParse({ kind: "element", locator: "img:nth-of-type(1)", quote: "" }).success).toBe(true);
  });

  it("drops unknown keys rather than keeping them", () => {
    const r = HtmlAnchorSchema.safeParse({ ...cell, html: "<img src=x onerror=alert(1)>" });
    expect(r.success).toBe(true);
    expect(r.success && "html" in r.data).toBe(false);
  });

  it("is an optional field of the comment target (old comments load unchanged)", () => {
    expect(CommentTargetSchema.safeParse({ artifactId: "art_1" }).success).toBe(true);
    const r = CommentTargetSchema.safeParse({ artifactId: "art_1", htmlAnchor: cell });
    expect(r.success && r.data.htmlAnchor?.table?.col).toBe("Staleness");
  });
});

describe("HtmlAnchorSchema — rejects", () => {
  const over = (n: number) => "x".repeat(n + 1);
  it.each([
    ["an unknown kind", { kind: "region", locator: "#a", quote: "a" }],
    ["a missing locator", { kind: "element", quote: "a" }],
    ["an empty locator", { kind: "element", locator: "", quote: "a" }],
    ["a missing quote", { kind: "element", locator: "#a" }],
    ["an over-length locator", { kind: "element", locator: over(HTML_ANCHOR_LIMITS.locator), quote: "a" }],
    ["an over-length quote", { kind: "element", locator: "#a", quote: over(HTML_ANCHOR_LIMITS.quote) }],
    ["an over-length prefix", { kind: "text", locator: "#a", quote: "a", prefix: over(HTML_ANCHOR_LIMITS.affix) }],
    ["an over-length suffix", { kind: "text", locator: "#a", quote: "a", suffix: over(HTML_ANCHOR_LIMITS.affix) }],
    ["an over-length header", { kind: "cell", locator: "#a", quote: "a", table: { col: over(HTML_ANCHOR_LIMITS.header) } }],
    ["an over-length nodeId", { kind: "diagram-node", locator: "#a", quote: "a", nodeId: over(HTML_ANCHOR_LIMITS.nodeId) }],
    ["an over-length href", { kind: "link", locator: "#a", quote: "a", href: over(HTML_ANCHOR_LIMITS.href) }],
    ["href on a non-link", { kind: "element", locator: "#a", quote: "a", href: "https://x" }],
    ["a text anchor with a blank quote", { kind: "text", locator: "#a", quote: "   " }],
    ["a non-integer version", { ...cell, version: 1.5 }],
    ["a string", "#a"],
    ["null", null],
  ])("%s", (_label, anchor) => {
    expect(HtmlAnchorSchema.safeParse(anchor).success).toBe(false);
  });
});

describe("CommentBodySchema — the HTTP boundary", () => {
  it("accepts a comment carrying a valid htmlAnchor", () => {
    const r = CommentBodySchema.safeParse({ artifactId: "art_1", content: "why this?", target: { artifactId: "art_1", htmlAnchor: cell } });
    expect(r.success).toBe(true);
  });

  it("refuses a malformed htmlAnchor with an issue under target.htmlAnchor", () => {
    const r = CommentBodySchema.safeParse({
      artifactId: "art_1",
      content: "why this?",
      target: { artifactId: "art_1", htmlAnchor: { kind: "element", locator: "x".repeat(600), quote: "a" } },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.path.slice(0, 2)).toEqual(["target", "htmlAnchor"]);
      expect(r.error.issues[0]!.message).toMatch(/invalid htmlAnchor/);
    }
  });

  it("leaves every other target untouched (no htmlAnchor → no check)", () => {
    expect(CommentBodySchema.safeParse({ artifactId: "a", content: "hi", target: { lineStart: 3 } }).success).toBe(true);
  });
});

describe("sanitizeHtmlAnchor — the store choke point", () => {
  it("keeps a valid anchor in its parsed form", () => {
    const out = sanitizeHtmlAnchor({ artifactId: "a", htmlAnchor: { ...cell, extra: 1 } });
    expect(out.htmlAnchor).toEqual(cell);
  });

  it("drops an invalid anchor, keeping the rest of the target", () => {
    const out = sanitizeHtmlAnchor({ artifactId: "a", lineStart: 3, htmlAnchor: { kind: "nope" } });
    expect(out).toEqual({ artifactId: "a", lineStart: 3 });
  });

  it("passes a target without an anchor through unchanged", () => {
    const t = { artifactId: "a", stepIndex: 0 };
    expect(sanitizeHtmlAnchor(t)).toBe(t);
    expect(sanitizeHtmlAnchor(undefined)).toBeUndefined();
  });
});
