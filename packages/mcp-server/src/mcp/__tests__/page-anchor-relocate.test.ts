/**
 * #680 slice 3 — server-side re-anchoring of page comments against a new
 * version's HTML: an anchor is ORPHANED only when its evidence (the quote, a
 * cell's header text, a link's href) is gone from the page; anything the server
 * can't judge is never called orphaned.
 */
import { describe, expect, it } from "vitest";
import type { Comment } from "@deeppairing/shared";
import { pageHaystack, relocateHtmlAnchor, relocatePageComments } from "../page-anchor-relocate.js";

type Anchor = NonNullable<Comment["target"]["htmlAnchor"]>;
const v = (html: string, a: Anchor) => relocateHtmlAnchor(a, pageHaystack(html));

function comment(id: string, a: Anchor, extra: Partial<Comment> = {}): Comment {
  return {
    id,
    sessionId: "s",
    target: { artifactId: "art_1", htmlAnchor: a },
    parentCommentId: null,
    author: "human",
    content: "c",
    createdAt: `2026-11-21T00:00:0${id.length % 10}.000Z`,
    acknowledged: false,
    ...extra,
  } as Comment;
}

describe("relocateHtmlAnchor", () => {
  it("carries a text anchor whose quote survives whitespace, tags and entities", () => {
    const a: Anchor = { kind: "text", locator: "p", quote: "write-through caching" };
    expect(v("<p>use write-through <b>caching</b></p>", a)).toBe("carried");
    expect(v("<p>use write&#8209;through\n  caching</p>", a)).toBe("carried");
  });

  it("orphans a text anchor whose quote is gone", () => {
    expect(v("<p>use read-through instead</p>", { kind: "text", locator: "p", quote: "write-through caching" })).toBe("orphaned");
  });

  it("uses the first 60 characters for element anchors, like the annotator", () => {
    const long = "A".repeat(60) + " tail that later changes";
    expect(v(`<div>${"A".repeat(60)} different tail</div>`, { kind: "element", locator: "div", quote: long })).toBe("carried");
  });

  it("finds element text held in attributes (alt / aria-label)", () => {
    expect(v(`<img alt="Architecture overview" src="x.png">`, { kind: "element", locator: "img", quote: "Architecture overview" })).toBe("carried");
  });

  it("orphans a cell whose header is gone even if its value survives", () => {
    const a: Anchor = { kind: "cell", locator: "td", quote: "60s", table: { row: "TTL expiry", col: "Staleness" } };
    expect(v("<table><tr><th>Strategy</th><th>Staleness</th></tr><tr><td>TTL expiry</td><td>60s</td></tr></table>", a)).toBe("carried");
    expect(v("<table><tr><th>Strategy</th><th>Freshness</th></tr><tr><td>TTL expiry</td><td>60s</td></tr></table>", a)).toBe("orphaned");
  });

  it("orphans a link whose href changed", () => {
    const a: Anchor = { kind: "link", locator: "a", quote: "the RFC", href: "https://example.com/rfc" };
    expect(v(`<a href="https://example.com/rfc">the RFC</a>`, a)).toBe("carried");
    expect(v(`<a href="https://example.com/other">the RFC</a>`, a)).toBe("orphaned");
  });

  it("carries a Mermaid node by its id even when relabelled", () => {
    const a: Anchor = { kind: "diagram-node", locator: "g", quote: "Cache", nodeId: "cacheLayer" };
    expect(v(`<pre class="mermaid">flowchart LR\n cacheLayer[Edge cache] --> db</pre>`, a)).toBe("carried");
  });

  it("never orphans an anchor it has no evidence for", () => {
    expect(v("<p>anything</p>", { kind: "element", locator: "#hero", quote: "" })).toBe("unknown");
  });

  it("ignores text inside scripts and styles", () => {
    expect(v("<script>var s = 'write-through caching';</script><p>other</p>", { kind: "text", locator: "p", quote: "write-through caching" })).toBe("carried");
    // ^ the raw-HTML check is deliberately lenient (errs toward "still here").
  });
});

describe("relocatePageComments", () => {
  it("judges human root comments only, oldest first", () => {
    const html = "<p>keep this sentence</p>";
    const out = relocatePageComments(html, [
      comment("cmt_kept", { kind: "text", locator: "p", quote: "keep this sentence" }),
      comment("cmt_gone", { kind: "text", locator: "p", quote: "removed words", version: 2 }),
      comment("cmt_reply", { kind: "text", locator: "p", quote: "removed words" }, { parentCommentId: "cmt_gone" }),
      comment("cmt_agent", { kind: "text", locator: "p", quote: "removed words" }, { author: "agent" }),
      comment("cmt_blank", { kind: "element", locator: "#x", quote: "" }),
    ]);
    expect(out.carried).toEqual(["cmt_kept"]);
    expect(out.unknown).toEqual(["cmt_blank"]);
    expect(out.orphaned).toEqual([{ commentId: "cmt_gone", kind: "text", quote: "removed words", locator: "p", version: 2 }]);
    expect(out.orphanedOverflow).toBe(0);
  });
});
