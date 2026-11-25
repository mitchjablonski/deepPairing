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

  it("skips asks inside containers the sanitizer drops (the human never sees them)", () => {
    const html =
      '<noscript><p id="ns" data-dp-question>In noscript?</p></noscript>' +
      '<object data="x.svg"><p id="ob" data-dp-question>In object?</p></object>' +
      '<iframe srcdoc="<p data-dp-question>x</p>"><p id="if" data-dp-question>In iframe?</p></iframe>' +
      '<applet><p id="ap" data-dp-decision>A</p></applet><portal><p id="po" data-dp-decision>P</p></portal>' +
      '<frameset><frame></frameset><embed src="x"><p id="seen" data-dp-question>Seen?</p>' +
      '<noscript><p id="tail" data-dp-question>Unclosed noscript hides the rest</p>';
    expect(extractPageAsks(html)).toEqual([{ id: "seen", kind: "question", text: "Seen?" }]);
  });

  it("treats self-closed drop tags as open (HTML ignores /> on them): their content stays hidden", () => {
    for (const tag of ["iframe", "noscript", "object"]) {
      const html = `<${tag}/><p id="hidden" data-dp-question>Hidden?</p></${tag}><p id="seen" data-dp-question>Seen?</p>`;
      expect(extractPageAsks(html).map((a) => a.id)).toEqual(["seen"]);
    }
  });

  it.each([
    ["li", '<ul><li id="q1" data-dp-question>Pick<li id="sib">Sibling</ul>'],
    ["dd", '<dl><dd id="q1" data-dp-question>Pick<dt id="sib">Sibling</dl>'],
    ["option", '<select><option id="q1" data-dp-question>Pick<option id="sib">Sibling</select>'],
    ["td", '<table><tr><td id="q1" data-dp-question>Pick<td id="sib">Sibling</table>'],
    ["tr", '<table><tbody><tr id="q1" data-dp-question><td>Pick<tr id="sib"><td>Sibling</table>'],
  ])("an unclosed %s ask ends where HTML closes it: a sibling's id is not a child, its text not the ask's", (_tag, html) => {
    const [ask] = extractPageAsks(html);
    expect(ask).toEqual({ id: "q1", kind: "question", text: "Pick" });
    expect(openPageAsks([ask!], [{ author: "human", parentCommentId: null, target: { htmlAnchor: { locator: "#sib", quote: "Sibling" } } }])).toHaveLength(1);
  });

  it("an implicitly closed item still owns its real children, and a nested list doesn't close it", () => {
    const html = '<ul><li id="q1" data-dp-question>Pick <ul><li id="inner">a</li><li>b</li></ul> <em id="note">n</em><li id="sib">Sibling</ul>';
    expect(extractPageAsks(html)).toEqual([{ id: "q1", kind: "question", text: "Pick a b n", childIds: ["inner", "note"] }]);
  });

  it("decodes every named entity the way the frame shows it (curly quotes, accents)", () => {
    expect(extractPageAsks('<p id="q" data-dp-question>Isn&rsquo;t &ldquo;caf&eacute;&rdquo; fine?</p>')).toEqual([
      { id: "q", kind: "question", text: "Isn\u2019t \u201Ccaf\u00E9\u201D fine?" },
    ]);
  });

  it("keeps ids of children inside the innermost ask (not of nested asks)", () => {
    const html = '<div id="o" data-dp-question>Q <em id="o-note">n</em><p id="i" data-dp-decision>D <b id="i-b">b</b></p></div><p id="after">x</p>';
    expect(extractPageAsks(html)).toEqual([
      { id: "o", kind: "question", text: "Q n D b", childIds: ["o-note"] },
      { id: "i", kind: "decision", text: "D b", childIds: ["i-b"] },
    ]);
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

  it("a comment on a child with its own id inside the ask answers it", () => {
    const withChild = extractPageAsks('<p id="q" data-dp-question>Region? <em id="q-note">eu</em></p>');
    expect(openPageAsks(withChild, [comment({ locator: "#q-note", quote: "eu" })])).toEqual([]);
  });

  it("an earlier version's answer counts for a reused id only if it quoted the ask's current text", () => {
    const current = { artifactId: "art_v2", version: 2 };
    const v2 = extractPageAsks('<div id="q1" data-dp-question>Which region?</div><div id="q2" data-dp-question>Which DB?</div>');
    const onV1 = (locator: string, quote: string) => ({ ...comment({ locator, quote }), target: { artifactId: "art_v1", htmlAnchor: { locator, quote, version: 1 } } });
    // q1 reused for a NEW question: the v1 answer quoted "Which DB?" → still open.
    // q2 kept its id and its text → the v1 answer still counts.
    const open = openPageAsks(v2, [onV1("#q1", "Which DB?"), onV1("#q2", "Which DB?")], current);
    expect(open.map((a) => a.id)).toEqual(["q1"]);
    // A same-version comment needs only the anchor match.
    const same = { ...comment({ locator: "#q1", quote: "anything" }), target: { artifactId: "art_v2", htmlAnchor: { locator: "#q1", quote: "anything", version: 2 } } };
    expect(openPageAsks(v2, [same], current).map((a) => a.id)).toEqual(["q2"]);
    // An earlier-version comment quoting only a label of the ask doesn't count.
    expect(openPageAsks(v2, [onV1("#q2", "Which")], current).map((a) => a.id)).toEqual(["q1", "q2"]);
  });

  describe("earlier-version answers after a revise", () => {
    const current = { artifactId: "art_v2", version: 2 };
    const onV1 = (locator: string, quote: string) => ({
      author: "human", parentCommentId: null, target: { artifactId: "art_v1", htmlAnchor: { locator, quote, version: 1 } },
    });
    const v2 = extractPageAsks(
      '<div id="db" data-dp-decision>Which database for sessions? <ul><li id="pg">Postgres</li><li id="my">MySQL</li></ul></div>' +
      '<p id="ent" data-dp-question>Isn&rsquo;t the &ldquo;caf&eacute;&rdquo; cache enough for now?</p>' +
      '<p id="d" data-dp-decision>Decide:</p>',
    );
    const openIds = (comments: unknown[]) => openPageAsks(v2, comments as never, current).map((a) => a.id);

    it("a comment on a child option still answers", () => {
      expect(openIds([onV1("#pg", "Postgres")])).toEqual(["ent", "d"]);
    });
    it("a text selection inside the ask still answers", () => {
      expect(openIds([onV1("#db", "database for sessions")])).toEqual(["ent", "d"]);
    });
    it("a Reply quoting the frame's text (curly quotes, accents) still answers", () => {
      expect(openIds([onV1("#ent", "Isn\u2019t the \u201Ccaf\u00E9\u201D cache enough for now?")])).toEqual(["db", "d"]);
      // …and straight quotes in the old quote fold to the same text.
      expect(openIds([onV1("#ent", "Isn't the \"café\" cache enough for now?")])).toEqual(["db", "d"]);
    });
    it("a reused id whose text changed stays open (the old quote isn't in the new text)", () => {
      const reused = extractPageAsks('<div id="db" data-dp-decision>Which region for the cluster?</div>');
      expect(openPageAsks(reused, [onV1("#db", "Which database for sessions?")] as never, current)).toHaveLength(1);
    });
    it("a short new ask needs an exact match: an old longer quote doesn't answer 'Decide:'", () => {
      expect(openIds([onV1("#d", "Decide: a 60s TTL, or invalidate on write?")])).toEqual(["db", "ent", "d"]);
      expect(openIds([onV1("#d", "Decide:")])).toEqual(["db", "ent"]);
      expect(openIds([onV1("#db", "Which d")])).toEqual(["db", "ent", "d"]); // under 8 characters
    });
  });

  it("a resolved comment does not answer an ask", () => {
    expect(openPageAsks(asks, [comment({ locator: "#decide-ttl", quote: "" }, { humanResolvedAt: "2026-01-01T00:00:00.000Z" })]).map((a) => a.id)).toEqual(["decide-ttl", "ask-budget"]);
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
