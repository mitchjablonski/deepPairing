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

  it("a nested table with an omitted </tr> doesn't leak scope past its </table>", () => {
    const html = '<table><tr><td id="q" data-dp-question>Q<table><tr><td id="inner">inner</table><td id="sib">S</table>';
    expect(extractPageAsks(html)).toEqual([{ id: "q", kind: "question", text: "Q inner", childIds: ["inner"] }]);
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

  describe("earlier-version answers: ask continuity", () => {
    const current = { artifactId: "art_v2", version: 2 };
    const onV1 = (locator: string, quote: string) => ({
      author: "human", parentCommentId: null, target: { artifactId: "art_v1", htmlAnchor: { locator, quote, version: 1 } },
    });
    const V1 =
      '<div id="db" data-dp-decision>Which database for sessions? <ul><li id="pg">Postgres</li><li id="my">MySQL</li></ul></div>' +
      '<p id="ent" data-dp-question>Isn&rsquo;t the &ldquo;caf&eacute;&rdquo; cache enough for now?</p>' +
      '<p id="d" data-dp-decision>Decide:</p>';
    const lookup = (versions: Record<string, string>) => (id: string) => (versions[id] !== undefined ? extractPageAsks(versions[id]!) : undefined);
    const openIds = (v2Html: string, comments: unknown[], versions: Record<string, string> = { art_v1: V1 }) =>
      openPageAsks(extractPageAsks(v2Html), comments as never, current, lookup(versions)).map((a) => a.id);

    it("the same question kept across a revise stays answered: child option, selection, entity Reply, short ask", () => {
      // v2 respells the entities and adds whitespace: still the same text.
      const V2 = V1.replace("&rsquo;", "\u2019").replace("Postgres</li>", "Postgres </li>");
      expect(openIds(V2, [onV1("#pg", "Postgres")])).toEqual(["ent", "d"]);
      expect(openIds(V2, [onV1("#db", "database for sessions")])).toEqual(["ent", "d"]);
      expect(openIds(V2, [onV1("#ent", "Isn\u2019t the \u201Ccaf\u00E9\u201D cache enough for now?")])).toEqual(["db", "d"]);
      expect(openIds(V2, [onV1("#d", "Decide:")])).toEqual(["db", "ent"]);
    });

    it("a reused id for a DIFFERENT question doesn't inherit the old answer (the Postgres probe)", () => {
      const V1db = '<div id="q1" data-dp-question>Which DB? <ul><li id="pg">Postgres</li><li>MySQL</li></ul></div>';
      const V2db = '<div id="q1" data-dp-question>Which Postgres version? <ul><li id="v15">15</li><li>16</li></ul></div>';
      expect(openIds(V2db, [onV1("#pg", "Postgres"), onV1("#q1", "Which DB? Postgres MySQL")], { art_v1: V1db })).toEqual(["q1"]);
    });

    it("a reworded question reopens", () => {
      const V2 = V1.replace("Which database for sessions?", "Which database for sessions and caches?");
      expect(openIds(V2, [onV1("#db", "Which database for sessions?")])).toEqual(["db", "ent", "d"]);
    });

    it("the old version's HTML unavailable, or the ask absent from it: the comment doesn't count", () => {
      expect(openIds(V1, [onV1("#pg", "Postgres")], {})).toEqual(["db", "ent", "d"]);
      expect(openPageAsks(extractPageAsks(V1), [onV1("#pg", "Postgres")] as never, current).map((a) => a.id)).toEqual(["db", "ent", "d"]);
      expect(openIds(V1, [onV1("#pg", "Postgres")], { art_v1: "<p>no asks</p>" })).toEqual(["db", "ent", "d"]);
    });

    it("the comment must have targeted the ask IN ITS OWN version (an old child id that moved out doesn't count)", () => {
      const V1moved = V1.replace('<li id="pg">Postgres</li>', "<li>Postgres</li>") + '<p id="pg">Postgres elsewhere</p>';
      expect(openIds(V1, [onV1("#pg", "Postgres")], { art_v1: V1moved })).toEqual(["db", "ent", "d"]);
    });

    it("a same-version comment needs only the anchor match", () => {
      const same = { author: "human", parentCommentId: null, target: { artifactId: "art_v2", htmlAnchor: { locator: "#d", quote: "x", version: 2 } } };
      expect(openIds(V1, [same])).toEqual(["db", "ent"]);
    });

    it("a clipped long ask continues when one text is a prefix of the other at the clip", () => {
      const long = (tail: string) => `<p id="L" data-dp-question>${"word ".repeat(600)}${tail}</p>`;
      expect(openIds(long("end"), [onV1("#L", "word")], { art_v1: long("different end") })).toEqual([]);
      const changedEarly = (w: string) => `<p id="L" data-dp-question>${w} ${"word ".repeat(600)}</p>`;
      expect(openIds(changedEarly("Alpha"), [onV1("#L", "word")], { art_v1: changedEarly("Beta") })).toEqual(["L"]);
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
