// @vitest-environment happy-dom
/**
 * #714 gap 5 — ask continuity needs the companion (parsed HTML, a hash fed
 * per text node) and the server (its text scanner, a hash fed per chunk
 * between tags) to compute the SAME full-text hash for the same ask, or an
 * answer would carry on one side and not the other.
 */
import { describe, it, expect } from "vitest";
// The companion's reader runs on DOMParser, hence the happy-dom environment.
// This lives with the server tests because the server tsconfig excludes
// tests, so importing the web module here doesn't cross a rootDir.
import { extractVersionAsks } from "../../../web/src/lib/pageAskVersions";
import { extractPageAsks } from "../page-asks.js";

const CASES: Array<[string, string]> = [
  ["plain", '<p id="a" data-dp-question>Which DB for sessions?</p>'],
  ["entities", '<p id="a" data-dp-question>Isn&rsquo;t &ldquo;caf&eacute;&rdquo; &amp; &lt;b&gt; fine&nbsp;here?</p>'],
  ["markup and br", '<div id="a" data-dp-decision><strong>Decide:</strong> a 60s TTL,<br>or <em>invalidate</em> on write?</div>'],
  ["list", '<div id="a" data-dp-decision>Pick one <ul><li id="pg">Postgres</li><li>MySQL</li></ul></div>'],
  ["unclosed li", '<ul><li id="a" data-dp-question>Pick<li id="sib">Sibling</ul>'],
  ["table", '<table><tr id="a" data-dp-question><td>TTL</td><td>60s</td></tr></table>'],
  ["skipped content", '<div id="a" data-dp-question>Keep <script>no()</script><style>.x{}</style><noscript>hidden</noscript>this</div>'],
  ["textarea", '<div id="a" data-dp-question>Notes: <textarea>typed &amp; kept</textarea></div>'],
  ["fallback", '<button id="a" data-dp-decision aria-label="Ship it?"></button>'],
  ["long", `<div id="a" data-dp-decision>${"Context sentence. ".repeat(300)}Which region?</div>`],
  ["comment inside", '<p id="a" data-dp-question>Split<!-- x -->text</p>'],
  ["chunks meeting without whitespace", '<p id="a" data-dp-question>a<b>c</b>d</p>'],
  ["chunks meeting at whitespace", '<p id="a" data-dp-question>a <b>c</b></p>'],
  ["whitespace-only node between blocks", '<div id="a" data-dp-decision><p>One</p>\n  <p>Two</p><p>Three</p></div>'],
  ["leading and trailing whitespace", '<p id="a" data-dp-question>\n   padded   \n</p>'],
  ["nbsp", '<p id="a" data-dp-question>no&nbsp;break&#160;here</p>'],
  ["br", '<p id="a" data-dp-question>now<br>here</p>'],
  ["br next to whitespace", '<p id="a" data-dp-question>now <br> here<br></p>'],
  ["list items", '<div id="a" data-dp-question><ul><li>Yes</li><li>No</li></ul></div>'],
  ["unclosed list items", '<ul id="a" data-dp-question><li>Yes<li>No</ul>'],
  ["table cells", '<table id="a" data-dp-question><tr><td>TTL</td><td>60s</td></tr><tr><td>Purge</td></tr></table>'],
  ["inline inside blocks", '<div id="a" data-dp-decision><p>Pick <b>one</b>:</p><p><em>Re</em>dis or <code>LRU</code></p></div>'],
  ["nested blocks and headings", '<section id="a" data-dp-question><h2>Q</h2><div><div>deep</div></div>tail</section>'],
];

describe("full-text hash parity: companion parse vs server scan", () => {
  it.each(CASES)("%s", (_label, html) => {
    const web = extractVersionAsks(html)!.find((a) => a.id === "a");
    const server = extractPageAsks(html).find((a) => a.id === "a");
    expect(web?.fullHash).toBeTruthy();
    expect(web?.fullHash).toBe(server?.fullHash);
  });

  it("different text, different hash; the same text respelled, the same hash", () => {
    const h = (html: string) => extractVersionAsks(html)![0]!.fullHash;
    expect(h('<p id="a" data-dp-question>Which DB?</p>')).not.toBe(h('<p id="a" data-dp-question>Which region?</p>'));
    expect(h('<p id="a" data-dp-question>Isn&rsquo;t it?</p>')).toBe(h("<p id=\"a\" data-dp-question>Isn't  it?</p>"));
    // Words stay apart: "now here" is not "nowhere", on either side.
    expect(h('<p id="a" data-dp-question>now here</p>')).not.toBe(h('<p id="a" data-dp-question>nowhere</p>'));
    const sv = (html: string) => extractPageAsks(html)[0]!.fullHash;
    expect(sv('<p id="a" data-dp-question>now here</p>')).not.toBe(sv('<p id="a" data-dp-question>nowhere</p>'));
    // A tag between two words isn't a space; whitespace across a tag is one.
    expect(h('<p id="a" data-dp-question>a<b>c</b>d</p>')).toBe(h('<p id="a" data-dp-question>acd</p>'));
    expect(h('<p id="a" data-dp-question>a <b>c</b></p>')).toBe(h('<p id="a" data-dp-question>a c</p>'));
    expect(h('<p id="a" data-dp-question>a <b> c</b></p>')).toBe(h('<p id="a" data-dp-question>a c</p>'));
    // A visible line break or block boundary is a separator; inline formatting isn't.
    for (const f of [h, sv]) {
      expect(f('<p id="a" data-dp-question>now<br>here</p>')).not.toBe(f('<p id="a" data-dp-question>nowhere</p>'));
      expect(f('<p id="a" data-dp-question>now<br>here</p>')).toBe(f('<p id="a" data-dp-question>now here</p>'));
      expect(f('<div id="a" data-dp-question><li>Yes</li><li>No</li></div>')).not.toBe(f('<div id="a" data-dp-question>YesNo</div>'));
      expect(f('<div id="a" data-dp-question><li>Yes</li><li>No</li></div>')).toBe(f('<div id="a" data-dp-question>Yes No</div>'));
      expect(f('<p id="a" data-dp-question>a<b>c</b>d</p>')).toBe(f('<p id="a" data-dp-question>acd</p>'));
      expect(f('<p id="a" data-dp-question>a<span>c</span><code>d</code></p>')).toBe(f('<p id="a" data-dp-question>acd</p>'));
    }
  });

  it.each(["pre", "listing", "textarea"])(
    "the server drops the newline right after <%s> as browsers do (happy-dom keeps it, so compare with the newline-free markup)",
    (tag) => {
      const withNl = `<div id="a" data-dp-question>x<${tag}>\ny</${tag}></div>`;
      const withCrlf = `<div id="a" data-dp-question>x<${tag}>\r\ny</${tag}></div>`;
      const browserView = `<div id="a" data-dp-question>x<${tag}>y</${tag}></div>`;
      const server = (html: string) => extractPageAsks(html)[0]!.fullHash;
      expect(server(withNl)).toBe(server(browserView));
      expect(server(withCrlf)).toBe(server(browserView));
      expect(server(withNl)).toBe(extractVersionAsks(browserView)![0]!.fullHash);
      // Only the FIRST newline goes: a second one is real text. (pre and
      // listing are block-level, so their boundary separates x and y anyway;
      // textarea is inline, so there the second newline is the only space.)
      if (tag === "textarea") {
        expect(server(`<div id="a" data-dp-question>x<${tag}>\n\ny</${tag}></div>`)).not.toBe(server(browserView));
      }
    },
  );

  it("skips asks inside drop containers and keeps only id'd asks with their own child ids", () => {
    const asks = extractVersionAsks(
      '<object><p id="h" data-dp-question>hidden</p></object><p data-dp-question>no id</p>' +
      '<div id="o" data-dp-question>Q <em id="o-c">c</em><p id="i" data-dp-decision>D <b id="i-c">b</b></p></div>',
    )!;
    expect(asks.map((a) => [a.id, a.childIds ?? []])).toEqual([["o", ["o-c"]], ["i", ["i-c"]]]);
  });
});
