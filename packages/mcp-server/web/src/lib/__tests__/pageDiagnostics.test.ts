/**
 * #714 gap 12 — the parent side of the frame's render diagnostics: accepted
 * only from THIS frame and only when it parses (bounded, and shaped so no URL
 * can ride in a resource or directive key), then worded as text for the banner
 * and the agent.
 */
import { describe, it, expect } from "vitest";
import { acceptDiagnosticsMessage, type PageDiagnostics } from "../pageAnchorMessages";
import {
  diagnosticsAgentSummary,
  diagnosticsDetails,
  diagnosticsHeadline,
  hasDiagnostics,
  redactDiagnosticText,
} from "../pageDiagnostics";

const frame = { name: "page-frame" } as unknown as Window;
const otherFrame = { name: "other-frame" } as unknown as Window;

const report = {
  dp: "diagnostics",
  scriptErrors: { count: 2, samples: ["TypeError: x is undefined"] },
  rejections: { count: 0, samples: [] },
  resources: [{ key: "img src", count: 3 }],
  blocked: [{ key: "img-src", count: 3 }],
};

describe("acceptDiagnosticsMessage", () => {
  it("accepts a valid report from this frame (without the dp tag)", () => {
    const { dp: _dp, ...rest } = report;
    expect(acceptDiagnosticsMessage({ source: frame, data: report }, frame)).toEqual(rest);
  });

  it("ignores a spoofed source: another frame, null, or no mounted frame", () => {
    expect(acceptDiagnosticsMessage({ source: otherFrame, data: report }, frame)).toBeNull();
    expect(acceptDiagnosticsMessage({ source: null, data: report }, frame)).toBeNull();
    expect(acceptDiagnosticsMessage({ source: frame, data: report }, null)).toBeNull();
  });

  it("refuses anything over the bounds or shaped to carry a URL", () => {
    const bad = (patch: Record<string, unknown>) => acceptDiagnosticsMessage({ source: frame, data: { ...report, ...patch } }, frame);
    expect(bad({ resources: [{ key: "img https://x.test/a.png", count: 1 }] })).toBeNull();
    expect(bad({ resources: [{ key: "img src=//x.test", count: 1 }] })).toBeNull();
    expect(bad({ blocked: [{ key: "https://x.test", count: 1 }] })).toBeNull();
    expect(bad({ scriptErrors: { count: 1, samples: ["a", "b", "c", "d"] } })).toBeNull();
    expect(bad({ scriptErrors: { count: 1, samples: ["x".repeat(121)] } })).toBeNull();
    expect(bad({ scriptErrors: { count: 10_000, samples: [] } })).toBeNull();
    expect(bad({ resources: Array.from({ length: 9 }, (_, i) => ({ key: `img${i} src`, count: 1 })) })).toBeNull();
    expect(bad({ extra: "field" })).toBeNull();
    expect(acceptDiagnosticsMessage({ source: frame, data: { ...report, dp: "anchor" } }, frame)).toBeNull();
  });
});

const d = (patch: Partial<PageDiagnostics>): PageDiagnostics => ({
  scriptErrors: { count: 0, samples: [] },
  rejections: { count: 0, samples: [] },
  resources: [],
  blocked: [],
  ...patch,
});

describe("diagnostics wording", () => {
  it("headline: script errors and broken images; element-paired CSP blocks are not double counted", () => {
    const { dp: _dp, ...rest } = report;
    expect(diagnosticsHeadline(rest as PageDiagnostics)).toBe("2 script errors and 3 images that didn't load");
    expect(diagnosticsHeadline(d({ rejections: { count: 1, samples: [] }, blocked: [{ key: "connect-src", count: 2 }] }))).toBe(
      "1 script error and 2 blocked requests",
    );
    expect(
      diagnosticsHeadline(d({ resources: [{ key: "video src", count: 1 }, { key: "link href", count: 2 }, { key: "img srcset", count: 1 }] })),
    ).toBe("1 image that didn't load, 1 media file that didn't load and 2 other assets that didn't load");
    // Only paired blocks reported (no element error seen): still says something.
    expect(diagnosticsHeadline(d({ blocked: [{ key: "img-src", count: 2 }] }))).toBe("2 blocked requests");
    expect(diagnosticsHeadline(d({}))).toBeNull();
    expect(hasDiagnostics(d({}))).toBe(false);
  });

  it("details list kinds, counts and redacted samples as text, plus the inline-as-data: hint", () => {
    const lines = diagnosticsDetails(
      d({
        scriptErrors: { count: 1, samples: ["Error at https://u:p@x.test/a.js"] },
        resources: [{ key: "img src", count: 3 }],
        blocked: [{ key: "img-src", count: 3 }],
      }),
    );
    expect(lines).toEqual([
      "Script errors (1): Error at [url]",
      "Didn't load: img src ×3",
      "Blocked by the frame's no-network policy: img-src ×3",
      "Relative and external asset paths can't load in the review frame; the page should inline them as data: URIs.",
    ]);
  });

  it("the agent summary is one bounded line with no URL", () => {
    const s = diagnosticsAgentSummary(
      d({
        scriptErrors: { count: 2, samples: ["TypeError at //cdn.x.test/a.js", "y".repeat(120)] },
        resources: [{ key: "img src", count: 3 }],
        blocked: [{ key: "img-src", count: 3 }],
      }),
      { version: 2, running: true },
    );
    expect(s.startsWith("v2, with the page's scripts running: 2 script errors (TypeError at [url] | ")).toBe(true);
    expect(s).toContain("didn't load: img src x3; blocked by the frame's no-network CSP: img-src x3");
    expect(s).not.toContain("cdn.x.test");
    expect(s.length).toBeLessThanOrEqual(500);
    expect(diagnosticsAgentSummary(d({ resources: [{ key: "img src", count: 1 }] }), { version: 1, running: false })).toBe(
      "v1, before Run (scripts off): didn't load: img src x1",
    );
  });

  it("redactDiagnosticText replaces URLs, protocol-relative URLs and data:/blob: URIs, then clips", () => {
    expect(redactDiagnosticText("see https://a.test/x?k=1 and //b.test/y and data:image/png;base64,AAA and blob:null/123")).toBe(
      "see [url] and [url] and [data URI] and [data URI]",
    );
    expect(redactDiagnosticText("a".repeat(200)).length).toBe(120);
  });
});
