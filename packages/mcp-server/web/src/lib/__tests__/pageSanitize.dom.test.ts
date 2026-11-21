/**
 * #680 slice 2 — the before-Run sanitiser: the agent's markup and CSS survive,
 * every way it could run script or leave the document does not.
 */
import { describe, it, expect } from "vitest";
import { sanitizePageHtml, isDangerousUrl, isSafeInlineStyle } from "../pageSanitize";

const clean = (h: string) => sanitizePageHtml(h).html;

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("sanitizePageHtml", () => {
  it("keeps markup, text and styles", () => {
    const out = clean("<style>h1{color:red}</style><h1 id=\"t\">Title</h1><table><tr><td>a</td></tr></table>");
    const doc = parse(out);
    expect(doc.querySelector("style")?.textContent).toContain("color:red");
    expect(doc.querySelector("#t")?.textContent).toBe("Title");
    expect(doc.querySelector("td")?.textContent).toBe("a");
  });

  it("strips every <script>, including SVG scripts and scripts in head", () => {
    const out = clean(
      "<head><script>alert(1)</script></head><p>x</p><script src=\"data:text/javascript,alert(2)\"></script>" +
        "<svg><script>alert(3)</script></svg><svg><SCRIPT>alert(4)</SCRIPT></svg>",
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert(");
    const doc = parse(out);
    expect(doc.getElementsByTagNameNS("*", "script")).toHaveLength(0);
    expect(doc.querySelector("p")?.textContent).toBe("x");
  });

  it("keeps ordinary SVG markup", () => {
    const out = clean("<svg viewBox=\"0 0 10 10\"><g class=\"node\"><circle r=\"2\"></circle><text>A</text></g></svg>");
    expect(out).toContain("<circle");
    expect(out).toContain("A");
  });

  it("strips every on* attribute", () => {
    const out = clean(
      "<img src=\"x.png\" onerror=\"alert(1)\"><button onclick=\"go()\" ONMOUSEOVER=\"x()\">b</button><svg onload=\"y()\"></svg>",
    );
    expect(out).not.toMatch(/\son[a-z]+=/i);
    const doc = parse(out);
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("x.png");
    expect(doc.querySelector("button")?.textContent).toBe("b");
  });

  it("strips javascript:, vbscript: and data:text/html URLs from href/src/action/formaction/xlink:href", () => {
    const out = clean(
      "<a href=\"javascript:alert(1)\">a</a>" +
        "<a href=\" JaVaScRiPt:alert(2)\">b</a>" +
        "<a href=\"java&#x09;script:alert(3)\">c</a>" +
        "<a href=\"vbscript:msgbox(1)\">d</a>" +
        "<a href=\"data:text/html,<script>alert(4)</script>\">e</a>" +
        "<form action=\"javascript:alert(5)\"><button formaction=\"javascript:alert(6)\">f</button></form>" +
        "<svg><a xlink:href=\"javascript:alert(7)\"><text>g</text></a></svg>" +
        "<a href=\"https://example.com/ok\">ok</a>",
    );
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out.toLowerCase()).not.toContain("vbscript:");
    expect(out.toLowerCase()).not.toContain("data:text/html");
    // An ordinary link keeps its href (the annotator stops it navigating).
    expect(parse(out).querySelector("a[href='https://example.com/ok']")).not.toBeNull();
  });

  it("strips <meta http-equiv=refresh> but keeps other metas", () => {
    const out = clean(
      "<meta http-equiv=\"Refresh\" content=\"0; url=https://evil.example\"><meta name=\"viewport\" content=\"width=device-width\"><p>x</p>",
    );
    expect(out.toLowerCase()).not.toContain("refresh");
    expect(out).toContain("viewport");
  });

  it("strips <base>, frames, plugins, <noscript> and <template>", () => {
    const out = clean(
      "<base href=\"https://evil.example/\"><iframe srcdoc=\"<script>1</script>\"></iframe><object data=\"x\"></object>" +
        "<embed src=\"x\"><noscript><p title=\"</noscript><img src=x onerror=alert(1)>\"></p></noscript>" +
        "<template><img src=x onerror=alert(2)></template><p>kept</p>",
    );
    const doc = parse(out);
    for (const tag of ["base", "iframe", "object", "embed", "noscript", "template"]) {
      expect(doc.querySelector(tag), tag).toBeNull();
    }
    expect(out).not.toContain("onerror");
    expect(doc.querySelector("p")?.textContent).toBe("kept");
  });

  it("strips an SVG animation that would rewrite an href", () => {
    const out = clean("<svg><a><set attributeName=\"href\" to=\"javascript:alert(1)\"/><text>x</text></a></svg>");
    expect(out.toLowerCase()).not.toContain("javascript:");
  });
});

describe("sanitizePageHtml — document attributes on the wrappers", () => {
  it("keeps the body class a stylesheet depends on, and drops body handlers", () => {
    const page = sanitizePageHtml(
      "<html><head><style>body.theme-dark h1{color:white}</style></head>" +
        "<body class=\"theme-dark wide\" onload=\"steal()\"><h1>Title</h1></body></html>",
    );
    expect(page.bodyAttrs).toEqual({ class: "theme-dark wide" });
    expect(page.html).toContain("body.theme-dark h1");
    expect(page.html).not.toContain("steal()");
  });

  it("keeps right-to-left direction and language from <html> and <body>", () => {
    const page = sanitizePageHtml("<html dir=\"rtl\" lang=\"ar\"><body dir=\"rtl\"><p>مرحبا</p></body></html>");
    expect(page.htmlAttrs).toEqual({ dir: "rtl", lang: "ar" });
    expect(page.bodyAttrs).toEqual({ dir: "rtl" });
  });

  it("keeps a plain inline style but drops one that loads or runs anything", () => {
    expect(sanitizePageHtml("<body style=\"background:#123;margin:0\"><p>x</p></body>").bodyAttrs).toEqual({ style: "background:#123;margin:0" });
    expect(sanitizePageHtml("<body style=\"background:url(https://evil.example/x)\"><p>x</p></body>").bodyAttrs).toEqual({});
    expect(sanitizePageHtml("<body style=\"width:expression(alert(1))\"><p>x</p></body>").bodyAttrs).toEqual({});
  });

  it("ignores an invalid dir and every attribute outside the allowlist", () => {
    const page = sanitizePageHtml("<body dir=\"sideways\" id=\"b\" data-x=\"1\"><p>x</p></body>");
    expect(page.bodyAttrs).toEqual({});
  });

  it("isSafeInlineStyle", () => {
    expect(isSafeInlineStyle("color: red; padding: 4px")).toBe(true);
    for (const bad of ["background: URL(x)", "x: expression(1)", "@import 'x'", "behavior: url(x.htc)", "-moz-binding: x", "content: '\\61'"]) {
      expect(isSafeInlineStyle(bad), bad).toBe(false);
    }
  });
});

describe("isDangerousUrl", () => {
  it.each(["javascript:alert(1)", "  javascript:x", "JAVASCRIPT:x", "java\tscript:x", "vbscript:x", "data:text/html,x", "data:application/xhtml+xml,x"])(
    "flags %j",
    (u) => expect(isDangerousUrl(u)).toBe(true),
  );
  it.each(["https://example.com", "#section", "data:image/png;base64,AAAA", "mailto:a@b.c"])("allows %j", (u) =>
    expect(isDangerousUrl(u)).toBe(false),
  );
});
