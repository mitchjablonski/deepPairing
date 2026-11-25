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
  });

  it("skips asks inside drop containers and keeps only id'd asks with their own child ids", () => {
    const asks = extractVersionAsks(
      '<object><p id="h" data-dp-question>hidden</p></object><p data-dp-question>no id</p>' +
      '<div id="o" data-dp-question>Q <em id="o-c">c</em><p id="i" data-dp-decision>D <b id="i-c">b</b></p></div>',
    )!;
    expect(asks.map((a) => [a.id, a.childIds ?? []])).toEqual([["o", ["o-c"]], ["i", ["i-c"]]]);
  });
});
