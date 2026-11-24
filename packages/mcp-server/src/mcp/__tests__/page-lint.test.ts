/**
 * #714 gap 6 — the present-time page lint. Pure function, real inputs.
 */
import { describe, expect, it } from "vitest";
import { lintPage, formatPageLintWarnings, PAGE_LINT_LONG_PAGE_BYTES } from "../page-lint.js";
import { PAGE_SKELETON_HTML } from "../../page-authoring.js";

const codes = (html: string) => lintPage(html).map((w) => w.code);
const clean = (body: string) => `<h1>Title</h1><section id="s"><h2>S</h2>${body}</section>`;

describe("lintPage", () => {
  it("the shared skeleton is clean", () => {
    expect(lintPage(PAGE_SKELETON_HTML)).toEqual([]);
  });

  it.each([
    ['<script src="https://cdn.example.com/mermaid.js"></script>'],
    ["<img src='http://example.com/a.png'>"],
    ['<img src=//example.com/a.png>'],
    ['<img srcset="a.png 1x, https://example.com/b.png 2x">'],
    ['<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'],
    ['<LINK REL="Preload Stylesheet" HREF="//x.test/s.css">'],
    ['<iframe src="https://example.com/embed"></iframe>'],
    ['<video poster="https://x.test/p.jpg"></video>'],
    ['<svg><image href="https://x.test/i.png"/></svg>'],
    ["<style>@import url('https://fonts.googleapis.com/css?family=Inter');</style>"],
    ['<style>body { background: url( "https://x.test/bg.png" ) }</style>'],
    ['<div style="background-image:url(//x.test/bg.png)">x</div>'],
  ])("warns on a blocked external asset: %s", (asset) => {
    const warnings = lintPage(clean(asset));
    expect(warnings.map((w) => w.code)).toEqual(["external_asset"]);
    expect(warnings[0]!.count).toBe(1);
    expect(warnings[0]!.urls).toHaveLength(1);
  });

  it("does not warn on navigation links, relative or data: assets, or URLs inside text, comments and scripts", () => {
    expect(codes(clean([
      '<a href="https://example.com/docs">docs</a>',
      '<svg><a href="https://example.com">x</a></svg>',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="images/a.png">',
      '<link rel="canonical" href="https://example.com/">',
      "<p>See https://example.com/a.png and <code>&lt;script src=\"https://x\"&gt;</code></p>",
      '<!-- <script src="https://cdn.example.com/x.js"></script> -->',
      '<script>const s = \'<img src="https://x.test/a.png">\';</script>',
      '<textarea><img src="https://x.test/a.png"></textarea>',
      '<p title="a>b <img src=https://x.test/q.png>">quoted</p>',
    ].join("")))).toEqual([]);
  });

  it("counts every blocked reference and quotes at most five distinct URLs", () => {
    const imgs = Array.from({ length: 8 }, (_, i) => `<img src="https://x.test/${i}.png">`).join("");
    const [w] = lintPage(clean(imgs));
    expect(w!.count).toBe(8);
    expect(w!.urls).toHaveLength(5);
    expect(w!.message).toContain("8 external asset references");
  });

  it("warns when the page has no headings at all", () => {
    expect(codes("<p>Just a paragraph</p>")).toEqual(["no_headings"]);
    expect(codes("<h3>Small heading</h3><p>ok</p>")).toEqual([]);
  });

  it("warns on a long page with no section or heading ids, and not on a short one", () => {
    const filler = `<p>${"word ".repeat(PAGE_LINT_LONG_PAGE_BYTES / 5)}</p>`;
    expect(codes(`<h1>Long</h1><section><h2>A</h2>${filler}</section>`)).toEqual(["no_section_ids"]);
    expect(codes(`<h1>Long</h1><section id="a"><h2>A</h2>${filler}</section>`)).toEqual([]);
    expect(codes(`<h1>Long</h1><h2 id="a">A</h2>${filler}`)).toEqual([]);
    expect(codes("<h1>Short</h1><section><h2>A</h2><p>short</p></section>")).toEqual([]);
  });

  it("formats warnings as a non-blocking text block, empty when clean", () => {
    expect(formatPageLintWarnings([])).toBe("");
    expect(formatPageLintWarnings(lintPage("<p>x</p>"))).toContain("Page warnings (non-blocking; the page was presented)");
  });

  it("stays linear on hostile 2 MB inputs (ReDoS guard)", () => {
    const size = 2 * 1024 * 1024;
    const hostile = [
      "<script>".repeat(size / 8),
      "<!--".repeat(size / 4),
      '<img src="'.repeat(size / 10),
      "<a ".repeat(size / 3),
      `<style>${"url(".repeat(size / 4 - 4)}</style>`,
      `<div style="${"url(   ".repeat(size / 7 - 2)}">`,
      "<".repeat(size),
      `<p ${"x=".repeat(size / 2 - 2)}>`,
    ];
    for (const html of hostile) {
      const start = performance.now();
      lintPage(html);
      expect(performance.now() - start, html.slice(0, 20)).toBeLessThan(2_000);
    }
  });
});
