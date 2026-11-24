/**
 * #714 gap 5 — the server-side scan of a page's asks (data-dp-decision /
 * data-dp-question): ids, kinds and text read from the page text without a
 * DOM, one forward pass, bounded, and linear on hostile markup.
 */
import { describe, it, expect } from "vitest";
import { PAGE_ASK_LIMITS } from "@deeppairing/shared";
import { extractPageAsks, openPageAsks, tagAttributes } from "../page-asks.js";

const SKELETON = `<!doctype html><html><body>
<header id="tldr"><h1>Profile cache</h1><p><strong>TL;DR:</strong> Redis.</p></header>
<section id="asks">
  <h2>What I need from you</h2>
  <p id="decide-ttl" data-dp-decision><strong>Decide:</strong> a 60s TTL, or invalidate on every write?</p>
  <p id='ask-budget' DATA-DP-QUESTION=""><strong>Question:</strong> is one more Redis instance in budget?</p>
</section>
</body></html>`;

describe("extractPageAsks", () => {
  it("reads the skeleton's asks: id, kind and text, in document order", () => {
    expect(extractPageAsks(SKELETON)).toEqual([
      { id: "decide-ttl", kind: "decision", text: "Decide: a 60s TTL, or invalidate on every write?" },
      { id: "ask-budget", kind: "question", text: "Question: is one more Redis instance in budget?" },
    ]);
  });

  it("returns nothing for a page without asks (fast path)", () => {
    expect(extractPageAsks("<h1>Plain</h1><p>No asks here.</p>")).toEqual([]);
  });

  it("decision wins when both are set; an ask without an id is still reported", () => {
    expect(extractPageAsks('<div data-dp-question data-dp-decision id="both">Pick</div><p data-dp-question>No id?</p>')).toEqual([
      { id: "both", kind: "decision", text: "Pick" },
      { kind: "question", text: "No id?" },
    ]);
  });

  it("an ask runs to its balancing close tag, nested same-name elements included", () => {
    const html = '<div id="a" data-dp-decision>Outer <div>inner</div> tail</div><div>after</div>';
    expect(extractPageAsks(html)).toEqual([{ id: "a", kind: "decision", text: "Outer inner tail" }]);
  });

  it("nested asks each get their own text", () => {
    const html = '<section id="o" data-dp-question>Q1 <p id="i" data-dp-decision>D1</p> more</section>';
    expect(extractPageAsks(html)).toEqual([
      { id: "o", kind: "question", text: "Q1 D1 more" },
      { id: "i", kind: "decision", text: "D1" },
    ]);
  });

  it("an unclosed <p> ask ends at the next block, as a browser closes it", () => {
    expect(extractPageAsks('<p id="q" data-dp-question>Is this ok?<p>Unrelated paragraph.')).toEqual([
      { id: "q", kind: "question", text: "Is this ok?" },
    ]);
  });

  it("decodes entities and ignores markup-looking attribute values and text in scripts, styles, comments", () => {
    const html =
      '<!-- <p id="c" data-dp-question>commented</p> -->' +
      '<script>const s = \'<p id="s" data-dp-decision>in script</p>\';</script>' +
      '<p title="a > b" id="t&amp;1" data-dp-question>Fish &amp; chips &lt;b&gt;?</p>' +
      '<p data-note="data-dp-decision" id="x">not an ask</p>';
    expect(extractPageAsks(html)).toEqual([{ id: "t&1", kind: "question", text: "Fish & chips <b>?" }]);
  });

  it("falls back to aria-label / title when the ask has no text", () => {
    expect(extractPageAsks('<button id="b" data-dp-decision aria-label="Ship it?"></button><img id="i" data-dp-question alt="Diagram right?">')).toEqual([
      { id: "b", kind: "decision", text: "Ship it?" },
      { id: "i", kind: "question", text: "Diagram right?" },
    ]);
  });

  it("bounds: at most 50 asks, text at most 200 chars, over-long ids dropped", () => {
    const many = Array.from({ length: 80 }, (_, i) => `<p id="a${i}" data-dp-question>${"q".repeat(400)}</p>`).join("");
    const asks = extractPageAsks(many);
    expect(asks).toHaveLength(PAGE_ASK_LIMITS.max);
    expect(asks.every((a) => a.text.length === PAGE_ASK_LIMITS.text)).toBe(true);
    expect(extractPageAsks(`<p id="${"x".repeat(201)}" data-dp-question>Q</p>`)).toEqual([{ kind: "question", text: "Q" }]);
  });

  it("stays linear on hostile input", () => {
    const cases = [
      // Many unclosed asks, then a flood of same-name tags.
      '<div data-dp-question id="q">x'.repeat(50) + "<div>".repeat(200_000),
      // Unbalanced quotes in every tag.
      "<a b='>".repeat(150_000) + '<p data-dp-decision id="z">tail</p>',
      '<p data-dp-question title="'.repeat(100_000),
      // Unterminated comments / scripts / tags.
      "<!---->".repeat(200_000) + '<p data-dp-question id="t">after</p>--!>',
      "<script".repeat(50_000) + "<a".repeat(50_000) + '<p data-dp-decision id="d">x</p>' + "<script>".repeat(50_000),
      // A 2 MB ask body.
      '<div data-dp-decision id="big">' + "word ".repeat(400_000) + "</div>",
    ];
    for (const html of cases) {
      const started = Date.now();
      extractPageAsks(html);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });
});

describe("tagAttributes", () => {
  it("tokenizes quoted and bare values; the first duplicate wins; names are lowercased", () => {
    const attrs = tagAttributes(`<p ID="one" id="two" Data-Dp-Decision title='a "b"' x=bare>`);
    expect(attrs.get("id")).toBe("one");
    expect(attrs.has("data-dp-decision")).toBe(true);
    expect(attrs.get("title")).toBe('a "b"');
    expect(attrs.get("x")).toBe("bare");
  });
});

describe("openPageAsks", () => {
  const asks = extractPageAsks(SKELETON);
  const comment = (anchor: { locator: string; quote: string }, extra: Record<string, unknown> = {}) => ({
    author: "human",
    parentCommentId: null,
    target: { htmlAnchor: anchor },
    ...extra,
  });

  it("an ask with a human comment anchored on it (by #id) or inside it is answered", () => {
    expect(openPageAsks(asks, [comment({ locator: "#decide-ttl", quote: "Decide: a 60s TTL" })]).map((a) => a.id)).toEqual(["ask-budget"]);
    expect(openPageAsks(asks, [comment({ locator: "#ask-budget > strong:nth-of-type(1)", quote: "Question:" })]).map((a) => a.id)).toEqual(["decide-ttl"]);
  });

  it("a comment on a TL;DR that restates the question does not answer it (no text fallback)", () => {
    const restated = comment({ locator: "#tldr > p:nth-of-type(1)", quote: "Question: is one more Redis instance in budget?" });
    const partial = comment({ locator: "body > p:nth-of-type(9)", quote: "one more Redis instance in budget" });
    expect(openPageAsks(asks, [restated, partial]).map((a) => a.id)).toEqual(["decide-ttl", "ask-budget"]);
  });

  it("an agent comment, a reply, a look-alike id or a bare quote does not answer an ask", () => {
    const open = openPageAsks(asks, [
      comment({ locator: "#decide-ttl", quote: "" }, { author: "agent" }),
      comment({ locator: "#decide-ttl", quote: "" }, { parentCommentId: "cmt_root" }),
      comment({ locator: "#decide-ttl-old", quote: "" }),
      comment({ locator: "body", quote: "Decide" }),
    ]);
    expect(open.map((a) => a.id)).toEqual(["decide-ttl", "ask-budget"]);
  });
});
