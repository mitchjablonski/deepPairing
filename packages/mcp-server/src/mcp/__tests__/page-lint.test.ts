/**
 * #714 gap 6 — the present-time page lint. Pure function, real inputs.
 */
import { describe, expect, it } from "vitest";
import { lintPage, formatPageLintWarnings, isRelativeUrl, PAGE_LINT_CODES, PAGE_LINT_LONG_PAGE_BYTES } from "../page-lint.js";
import { PAGE_SKELETON_HTML } from "../../page-authoring.js";

const codes = (html: string) => lintPage(html).map((w) => w.code);
const clean = (body: string) => `<h1>Title</h1><section id="s"><h2>S</h2>${body}</section>`;

describe("lintPage", () => {
  it("the shared skeleton is clean", () => {
    expect(lintPage(PAGE_SKELETON_HTML)).toEqual([]);
  });

  it.each([
    ['<script src="https://cdn.example.com/mermaid.js"></script>', "script src"],
    ["<img src='http://example.com/a.png'>", "img src"],
    ["<img src=//example.com/a.png>", "img src"],
    ['<img srcset="data:image/png;base64,AA 1x, https://example.com/b.png 2x">', "img srcset"],
    ['<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">', "link href (stylesheet)"],
    ['<LINK REL="Preload Stylesheet" HREF="//x.test/s.css">', "link href (stylesheet)"],
    ['<iframe src="https://example.com/embed"></iframe>', "iframe src"],
    ['<video poster="https://x.test/p.jpg"></video>', "video poster"],
    ['<svg><image href="https://x.test/i.png"/></svg>', "image href"],
    ["<style>@import url('https://fonts.googleapis.com/css?family=Inter');</style>", "CSS @import in <style>"],
    ['<style>@import "https://x.test/a.css";</style>', "CSS @import in <style>"],
    ['<style>body { background: url( "https://x.test/bg.png" ) }</style>', "CSS url() in <style>"],
    ["<style>body { background: url(https://x.test/bg.png) }</style>", "CSS url() in <style>"],
    ['<div style="background-image:url(//x.test/bg.png)">x</div>', "CSS url() in a style attribute"],
  ])("warns on a blocked external asset, classified by tag and attribute: %s", (asset, source) => {
    const warnings = lintPage(clean(asset));
    expect(warnings.map((w) => w.code)).toEqual(["external_asset"]);
    expect(warnings[0]!.count).toBe(1);
    expect(warnings[0]!.sources).toEqual([{ source, count: 1 }]);
    expect(warnings[0]!.message).toContain(`${source} x1`);
  });

  it("never echoes the URL: credentials, signed params and hosts stay out of text and structure", () => {
    const secret = "https://user:pass@assets.secret-host.test/a.png?token=abc123&sig=XYZ";
    const html = clean([
      `<img src="${secret}">`,
      `<script src="${secret}"></script>`,
      `<link rel="stylesheet" href="${secret}">`,
      `<style>body { background: url(${secret}) }</style>`,
      `<div style="background: url('${secret}')">x</div>`,
    ].join(""));
    const warnings = lintPage(html);
    expect(warnings).toHaveLength(1);
    const out = JSON.stringify(warnings) + formatPageLintWarnings(warnings);
    for (const leak of ["user:pass", "token=", "abc123", "sig=", "secret-host", "assets.", "https://", "a.png"]) {
      expect(out).not.toContain(leak);
    }
    expect(warnings[0]!.sources).toEqual([
      { source: "img src", count: 1 },
      { source: "script src", count: 1 },
      { source: "link href (stylesheet)", count: 1 },
      { source: "CSS url() in <style>", count: 1 },
      { source: "CSS url() in a style attribute", count: 1 },
    ]);
  });

  it("gives precise inlining advice (images and fonts as data:, media never loads)", () => {
    const [w] = lintPage(clean('<img src="https://x.test/a.png">'));
    expect(w!.message).toContain("images and fonts as data: URIs");
    expect(w!.message).toContain("video, audio, iframes and objects won't load");
    expect(w!.message).not.toMatch(/data: URIs work\b/);
  });

  it("skips commented-out CSS in <style> and style attributes", () => {
    expect(codes(clean("<style>/* body { background: url(https://x.test/bg.png) } */ p { color: red }</style>"))).toEqual([]);
    expect(codes(clean('<style>/* @import "https://x.test/a.css"; */</style>'))).toEqual([]);
    expect(codes(clean('<p style="/* background: url(//x.test/a.png) */ color: red">x</p>'))).toEqual([]);
    // Code after the comment still counts.
    expect(lintPage(clean("<style>/* x */ body { background: url(https://x.test/a.png) }</style>"))[0]!.sources)
      .toEqual([{ source: "CSS url() in <style>", count: 1 }]);
  });

  it("skips <noscript> content (the sanitizer drops it before render)", () => {
    expect(codes(clean('<noscript><img src="https://x.test/pixel.gif"><link rel="stylesheet" href="https://x.test/a.css"></noscript>'))).toEqual([]);
    // ...and resumes after it.
    expect(lintPage(clean('<noscript>x</noscript><img src="https://x.test/a.png">'))[0]!.sources).toEqual([{ source: "img src", count: 1 }]);
  });

  // (A relative asset gets its own relative_asset warning since #714 gap 12;
  // see the describe block below.)
  it("does not warn on navigation links, data: assets, or URLs inside text, comments and scripts", () => {
    expect(codes(clean([
      '<a href="https://example.com/docs">docs</a>',
      '<svg><a href="https://example.com">x</a></svg>',
      '<img src="data:image/png;base64,AAAA">',
      '<link rel="canonical" href="https://example.com/">',
      "<p>See https://example.com/a.png and <code>&lt;script src=\"https://x\"&gt;</code></p>",
      '<!-- <script src="https://cdn.example.com/x.js"></script> -->',
      '<script>const s = \'<img src="https://x.test/a.png">\';</script>',
      '<textarea><img src="https://x.test/a.png"></textarea>',
      '<p title="a>b <img src=https://x.test/q.png>">quoted</p>',
    ].join("")))).toEqual([]);
  });

  it("counts every blocked reference, grouped by source", () => {
    const imgs = Array.from({ length: 8 }, (_, i) => `<img src="https://x.test/${i}.png">`).join("");
    const [w] = lintPage(clean(imgs + '<img srcset="https://x.test/a.png 1x, //x.test/b.png 2x">'));
    expect(w!.count).toBe(10);
    expect(w!.sources).toEqual([{ source: "img src", count: 8 }, { source: "img srcset", count: 2 }]);
    expect(w!.message).toContain("10 external asset references");
    expect(w!.message).toContain("img src x8, img srcset x2");
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
      `<style>${"/*".repeat(size / 2 - 4)}</style>`,
      `<style>${"@import ".repeat(size / 8 - 2)}</style>`,
      "<noscript>".repeat(size / 10),
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

describe("lintPage — relative_asset (#714 gap 12)", () => {
  it.each([
    ['<img src="shot.png">', "img src"],
    ['<img src="./img/a.svg">', "img src"],
    ['<img src="/logo.png">', "img src"],
    ['<img src="../up.png?v=2">', "img src"],
    ['<img srcset="a.png 1x, data:image/png;base64,AA 2x">', "img srcset"],
    ['<picture><source srcset="wide.webp"></picture>', "source srcset"],
    ['<video src="demo.mp4" ></video>', "video src"],
    ['<video poster="poster.jpg"></video>', "video poster"],
    ['<audio src="a.mp3"></audio>', "audio src"],
    ['<link rel="stylesheet" href="styles.css">', "link href (stylesheet)"],
    ['<svg><use href="sprites.svg#icon"/></svg>', "use href"],
  ])("warns, classified by tag and attribute and never echoing the path: %s", (asset, source) => {
    const warnings = lintPage(clean(asset));
    expect(warnings.map((w) => w.code)).toEqual([PAGE_LINT_CODES.relative_asset]);
    expect(warnings[0]!.code).toBe("relative_asset");
    expect(warnings[0]!.sources).toEqual([{ source, count: 1 }]);
    expect(warnings[0]!.message).toContain("won't load in the review frame");
    expect(warnings[0]!.message).toContain("data: URIs");
    for (const path of ["shot.png", "img/a.svg", "logo.png", "demo.mp4", "styles.css", "sprites.svg"]) {
      expect(JSON.stringify(warnings)).not.toContain(path);
    }
  });

  it("never warns on data:/blob: URIs, same-document fragments, empty values, plain links or non-asset rels", () => {
    expect(
      codes(
        clean(
          '<img src="data:image/png;base64,AA"><img src="blob:null/1"><svg><use href="#icon"/></svg><img src="">' +
            '<a href="other.html">next</a><link rel="canonical" href="page.html">',
        ),
      ),
    ).toEqual([]);
  });

  it("counts external and relative separately, external first, and both before no_headings", () => {
    const warnings = lintPage('<p>x</p><img src="https://x.test/a.png"><img src="a.png"><img src="b.png">');
    expect(warnings.map((w) => w.code)).toEqual(["external_asset", "relative_asset", "no_headings"]);
    expect(warnings[1]!.count).toBe(2);
    expect(formatPageLintWarnings(warnings)).toContain("2 relative asset paths won't load in the review frame: img src x2");
  });

  it("isRelativeUrl", () => {
    for (const v of ["a.png", "./a", "/a", "../a", "a/b:c", "?q", " x.png "]) expect(isRelativeUrl(v), v).toBe(true);
    for (const v of ["", "  ", "#frag", "data:x", "blob:x", "https://x", "//x", "mailto:a", "javascript:void(0)", "C:x"]) {
      expect(isRelativeUrl(v), v).toBe(false);
    }
  });
});

