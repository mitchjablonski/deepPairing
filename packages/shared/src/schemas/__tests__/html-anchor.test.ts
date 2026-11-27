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

describe("HtmlAnchorSchema — section context (#714 gap 10)", () => {
  it("an anchor stored before gap 10 (no section, no element affixes) parses unchanged", () => {
    const legacy = { kind: "element", locator: "div:nth-of-type(3)", quote: "Rollout plan", version: 2 };
    const r = HtmlAnchorSchema.safeParse(legacy);
    expect(r.success && r.data).toEqual(legacy);
  });

  it("accepts section {heading, id} (each optional) and prefix/suffix on element, cell, node and link anchors", () => {
    for (const section of [{ heading: "Rollout", id: "rollout" }, { heading: "Rollout" }, { id: "rollout" }, {}]) {
      expect(HtmlAnchorSchema.safeParse({ kind: "element", locator: "#x", quote: "q", section }).success).toBe(true);
    }
    const affix = { prefix: "before it", suffix: "after it", section: { heading: "Risks", id: "risks" } };
    for (const a of [
      { kind: "element", locator: "#x", quote: "q" },
      cell,
      { kind: "diagram-node", locator: "#n", quote: "A", nodeId: "A" },
      { kind: "link", locator: "#l", quote: "the RFC", href: "https://example.com" },
    ]) {
      const r = HtmlAnchorSchema.safeParse({ ...a, ...affix });
      expect(r.success && r.data.section).toEqual({ heading: "Risks", id: "risks" });
    }
  });

  it("caps the heading at 120 and the id at 200 characters, and drops unknown section keys", () => {
    const base = { kind: "element", locator: "#x", quote: "q" };
    expect(HTML_ANCHOR_LIMITS.sectionHeading).toBe(120);
    expect(HTML_ANCHOR_LIMITS.sectionId).toBe(200);
    expect(HtmlAnchorSchema.safeParse({ ...base, section: { heading: "h".repeat(120), id: "i".repeat(200) } }).success).toBe(true);
    expect(HtmlAnchorSchema.safeParse({ ...base, section: { heading: "h".repeat(121) } }).success).toBe(false);
    expect(HtmlAnchorSchema.safeParse({ ...base, section: { id: "i".repeat(201) } }).success).toBe(false);
    expect(HtmlAnchorSchema.safeParse({ ...base, section: "Rollout" }).success).toBe(false);
    const r = HtmlAnchorSchema.safeParse({ ...base, section: { heading: "R", html: "<b>" } });
    expect(r.success && r.data.section).toEqual({ heading: "R" });
  });

  it("the store sanitiser keeps a valid section", () => {
    const t = sanitizeHtmlAnchor({ artifactId: "a", htmlAnchor: { kind: "element", locator: "#x", quote: "q", section: { id: "rollout" } } });
    expect((t as any).htmlAnchor.section).toEqual({ id: "rollout" });
  });
});
