/**
 * #680 — the visible-text extraction the rejection gate reads for a page.
 */
import { describe, expect, it } from "vitest";
import { extractPageTextBlocks, PAGE_TEXT_MAX_BLOCKS } from "../page-text.js";

describe("extractPageTextBlocks", () => {
  it("returns one string per block, in document order", () => {
    expect(extractPageTextBlocks("<h1>Title</h1><p>First   paragraph.</p><ul><li>One</li><li>Two</li></ul>"))
      .toEqual(["Title", "First paragraph.", "One", "Two"]);
  });

  it("keeps inline elements inside their block", () => {
    expect(extractPageTextBlocks("<p>Use <strong>write-through</strong> <em>purge</em>.</p>"))
      .toEqual(["Use write-through purge ."]);
  });

  it("drops script, style, template, noscript, head and comments whole", () => {
    const html =
      "<html><head><title>T</title><style>p{color:red}</style></head><body>" +
      "<script>var hidden = 'Railway';</script><!-- Railway --><template><p>Railway</p></template>" +
      "<noscript>Railway</noscript><p>Visible text</p></body></html>";
    expect(extractPageTextBlocks(html)).toEqual(["Visible text"]);
  });

  it("is case-insensitive about tag names", () => {
    expect(extractPageTextBlocks("<SCRIPT>bad()</SCRIPT><P>ok</P>")).toEqual(["ok"]);
  });

  it("drops the rest of the page after an unterminated script", () => {
    expect(extractPageTextBlocks("<p>before</p><script>never closed <p>after</p>")).toEqual(["before"]);
  });

  it("treats a stray < with no closing > as text", () => {
    expect(extractPageTextBlocks("<p>a < b</p>")).toEqual(["a"]);
    expect(extractPageTextBlocks("3 < 4 and more")).toEqual(["3 < 4 and more"]);
  });

  it("decodes common entities", () => {
    expect(extractPageTextBlocks("<p>Fish &amp; chips &lt;3 &#39;x&#x27; &nbsp;y &bogus;</p>"))
      .toEqual(["Fish & chips <3 'x' y &bogus;"]);
  });

  it("splits table cells into their own blocks", () => {
    expect(extractPageTextBlocks("<table><tr><th>Strategy</th><td>TTL expiry</td></tr></table>"))
      .toEqual(["Strategy", "TTL expiry"]);
  });

  it("does not let a non-ASCII character shift tag detection", () => {
    expect(extractPageTextBlocks("<p>İstanbul</p><script>x</script><p>after</p>")).toEqual(["İstanbul", "after"]);
  });

  it("caps the number of blocks", () => {
    const html = Array.from({ length: PAGE_TEXT_MAX_BLOCKS + 50 }, (_, i) => `<p>b${i}</p>`).join("");
    expect(extractPageTextBlocks(html)).toHaveLength(PAGE_TEXT_MAX_BLOCKS);
  });

  it("stays fast on many unterminated tags (linear scan)", () => {
    const hostile = "<script".repeat(50_000) + "<a".repeat(50_000);
    const started = Date.now();
    extractPageTextBlocks(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
