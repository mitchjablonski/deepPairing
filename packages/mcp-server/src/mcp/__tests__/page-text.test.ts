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
      .toEqual(["Use write-through purge."]);
  });

  it("inline tags vanish rather than splitting a word (review P3)", () => {
    expect(extractPageTextBlocks("<p>Rail<b></b>way</p>")).toEqual(["Railway"]);
    expect(extractPageTextBlocks("<p>Rail<span class='x'>way</span> now</p>")).toEqual(["Railway now"]);
  });

  it("drops the bodies of script, style, template and title, and comments", () => {
    const html =
      "<html><head><title>T</title><style>p{color:red}</style></head><body>" +
      "<script>var hidden = 'Railway';</script><!-- Railway --><template><p>Railway</p></template>" +
      "<p>Visible text</p></body></html>";
    expect(extractPageTextBlocks(html)).toEqual(["Visible text"]);
  });

  it("an unclosed <head> does not hide the body (review P1)", () => {
    expect(extractPageTextBlocks("<html><head><title>x</title><body><p>Deploy on Railway</p>"))
      .toEqual(["Deploy on Railway"]);
  });

  it("text a browser moves out of <head> is extracted (review P1)", () => {
    expect(extractPageTextBlocks("<head><p>visible</p></head><body></body>")).toEqual(["visible"]);
  });

  it("<noscript> text is extracted: the first render has scripting disabled (review P2)", () => {
    expect(extractPageTextBlocks("<noscript><p>Deploy on Railway</p></noscript><p>after</p>"))
      .toEqual(["Deploy on Railway", "after"]);
  });

  it("abrupt empty comments end immediately (review P2)", () => {
    expect(extractPageTextBlocks("<p><!-->Deploy on Railway<!-- --></p>")).toEqual(["Deploy on Railway"]);
    expect(extractPageTextBlocks("<p><!--->Deploy on Railway<!-- --></p>")).toEqual(["Deploy on Railway"]);
    expect(extractPageTextBlocks("<p><!-- a --!>shown</p>")).toEqual(["shown"]);
  });

  it("a comment opener inside <textarea> or <title> is not a comment (review P2)", () => {
    expect(extractPageTextBlocks("<textarea><!-- not a comment</textarea><p>Deploy on Railway</p><!-- real -->"))
      .toEqual(["<!-- not a comment", "Deploy on Railway"]);
    expect(extractPageTextBlocks("<title><!--</title><p>Deploy on Railway</p><!-- -->")).toEqual(["Deploy on Railway"]);
  });

  it("is case-insensitive about tag names", () => {
    expect(extractPageTextBlocks("<SCRIPT>bad()</SCRIPT><P>ok</P>")).toEqual(["ok"]);
  });

  it("an unterminated drop element skips only its opening tag, never the rest of the page (review P1)", () => {
    expect(extractPageTextBlocks("<p>before</p><script>never closed <p>after</p>"))
      .toEqual(["before", "never closed", "after"]);
    expect(extractPageTextBlocks("<style><p>Deploy on Railway</p>")).toEqual(["Deploy on Railway"]);
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

  it("<xmp> content is literal text, so a comment opener inside it opens nothing (review N2)", () => {
    expect(extractPageTextBlocks("<xmp><!--</xmp><p>Deploy on Railway</p>-->")).toContain("Deploy on Railway");
  });

  it("everything after <plaintext> is literal text (review N2)", () => {
    expect(extractPageTextBlocks("<p>a b</p><plaintext><!-- Deploy on Railway -->"))
      .toEqual(["a b", "<!-- Deploy on Railway -->"]);
  });

  it("caps the number of blocks", () => {
    const html = Array.from({ length: PAGE_TEXT_MAX_BLOCKS + 50 }, (_, i) => `<p>b${i}</p>`).join("");
    expect(extractPageTextBlocks(html)).toHaveLength(PAGE_TEXT_MAX_BLOCKS);
  });

  it("stays fast on many empty comments with a single trailing --!> (review N1)", () => {
    const hostile = "<!---->".repeat(300_000) + "<p>tail</p>--!>";
    const started = Date.now();
    const blocks = extractPageTextBlocks(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(blocks).toContain("tail");
  });

  it("stays fast on many unterminated tags (linear scan)", () => {
    const hostile = "<script".repeat(50_000) + "<a".repeat(50_000) + "<script>".repeat(50_000) + "<!--x-->".repeat(50_000);
    const started = Date.now();
    extractPageTextBlocks(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
