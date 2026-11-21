/**
 * #680 slice 2 — the annotator script, evaluated from the EXACT shipped source
 * strings: its pure helpers (locator building, anchors for each kind, quote
 * extraction, re-finding) and its event wiring (link clicks never navigate,
 * clicks and selections post anchors to the parent, pins drawn with textContent
 * only and reported back, messages from anyone but the parent ignored).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HtmlAnchorSchema } from "@deeppairing/shared";
import { ANNOTATOR_CORE_SOURCE, ANNOTATOR_MAIN_SOURCE, ANNOTATOR_SCRIPT } from "../pageAnnotator";

type Core = {
  buildLocator(el: Element): string;
  anchorForTarget(t: Node): Record<string, any> | null;
  textAnchor(r: Range): Record<string, any> | null;
  findAnchor(a: unknown): { el: Element; range: Range | null } | null;
  findQuote(text: string, quote: string, prefix?: string, suffix?: string): number;
  mermaidNodeId(g: Element): string;
};

function makeCore(): Core {
  return new Function("document", "window", ANNOTATOR_CORE_SOURCE)(document, window) as Core;
}

const PAGE =
  "<h1 id=\"title\">Cache invalidation</h1>" +
  "<p class=\"intro\">You can pick one of three strategies for the session cache.</p>" +
  "<section><p>First paragraph.</p><p>Second <b>bold</b> paragraph.</p></section>" +
  "<table><thead><tr><th>Strategy</th><th>Staleness</th></tr></thead>" +
  "<tbody><tr><td>TTL expiry</td><td>Up to 60s</td></tr><tr><td>Write-through purge</td><td>None</td></tr></tbody></table>" +
  "<svg><g class=\"node\" id=\"flowchart-AuthGate-1\"><text>AuthGate</text></g></svg>" +
  "<a id=\"rfc\" href=\"https://example.com/rfc\">the RFC</a>" +
  "<div data-testid=\"card\"><span>Card body</span></div>";

beforeEach(() => {
  document.body.innerHTML = PAGE;
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("annotator core — anchors for each kind", () => {
  it("prefers a unique #id for the locator", () => {
    const core = makeCore();
    expect(core.buildLocator(document.getElementById("title")!)).toBe("#title");
  });

  it("uses a unique stable data-* attribute before nth-of-type", () => {
    const core = makeCore();
    const span = document.querySelector("[data-testid=card] span")!;
    const loc = core.buildLocator(span);
    expect(loc).toBe('div[data-testid="card"] > span:nth-of-type(1)');
    expect(document.querySelector(loc)).toBe(span);
  });

  it("falls back to tag:nth-of-type steps that resolve to the same element", () => {
    const core = makeCore();
    const second = document.querySelectorAll("section p")[1]!;
    const loc = core.buildLocator(second);
    expect(loc).toContain("p:nth-of-type(2)");
    expect(document.querySelector(loc)).toBe(second);
  });

  it("an element click → element anchor with its text as the quote", () => {
    const core = makeCore();
    const a = core.anchorForTarget(document.querySelector(".intro")!)!;
    expect(a.kind).toBe("element");
    expect(a.quote).toBe("You can pick one of three strategies for the session cache.");
    expect(HtmlAnchorSchema.safeParse(a).success).toBe(true);
  });

  it("a cell click → cell anchor with the row and column header text", () => {
    const core = makeCore();
    const td = document.querySelectorAll("tbody td")[1]!; // "Up to 60s"
    const a = core.anchorForTarget(td)!;
    expect(a.kind).toBe("cell");
    expect(a.quote).toBe("Up to 60s");
    expect(a.table).toEqual({ row: "TTL expiry", col: "Staleness" });
    expect(document.querySelector(a.locator)).toBe(td);
    expect(HtmlAnchorSchema.safeParse(a).success).toBe(true);
  });

  it("a header cell → its own text as the column", () => {
    const core = makeCore();
    const a = core.anchorForTarget(document.querySelectorAll("th")[1]!)!;
    expect(a.kind).toBe("cell");
    expect(a.table).toEqual({ col: "Staleness" });
  });

  it("a Mermaid node click → diagram-node anchor with the node id", () => {
    const core = makeCore();
    const a = core.anchorForTarget(document.querySelector("svg text")!)!;
    expect(a.kind).toBe("diagram-node");
    expect(a.nodeId).toBe("AuthGate");
    expect(a.quote).toBe("AuthGate");
    expect(HtmlAnchorSchema.safeParse(a).success).toBe(true);
  });

  it("parses Mermaid ids with prefixes and data-id", () => {
    const core = makeCore();
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("id", "mermaid-7-flowchart-Cache-Layer-12");
    expect(core.mermaidNodeId(g)).toBe("Cache-Layer");
    g.setAttribute("data-id", "CacheLayer");
    expect(core.mermaidNodeId(g)).toBe("CacheLayer");
  });

  it("a link click → link anchor with its href", () => {
    const core = makeCore();
    const a = core.anchorForTarget(document.getElementById("rfc")!)!;
    expect(a).toMatchObject({ kind: "link", locator: "#rfc", quote: "the RFC", href: "https://example.com/rfc" });
    expect(HtmlAnchorSchema.safeParse(a).success).toBe(true);
  });

  it("a text selection → text anchor with quote, prefix and suffix", () => {
    const core = makeCore();
    const textNode = document.querySelector(".intro")!.firstChild!;
    const range = document.createRange();
    const start = "You can pick one of ".length;
    range.setStart(textNode, start);
    range.setEnd(textNode, start + "three strategies".length);
    const a = core.textAnchor(range)!;
    expect(a.kind).toBe("text");
    expect(a.quote).toBe("three strategies");
    expect(a.prefix!.endsWith("pick one of")).toBe(true);
    expect(a.suffix!.startsWith("for the session")).toBe(true);
    expect(a.prefix!.length).toBeLessThanOrEqual(32);
    expect(a.suffix!.length).toBeLessThanOrEqual(32);
    expect(HtmlAnchorSchema.safeParse(a).success).toBe(true);
  });

  it("caps a long element quote at 280 characters", () => {
    document.body.innerHTML = `<p id="long">${"word ".repeat(200)}</p>`;
    const core = makeCore();
    const a = core.anchorForTarget(document.getElementById("long")!)!;
    expect(a.quote.length).toBeLessThanOrEqual(280);
    expect(HtmlAnchorSchema.safeParse(a).success).toBe(true);
  });
});

describe("annotator core — re-finding anchors", () => {
  it("finds an anchor by its locator", () => {
    const core = makeCore();
    const hit = core.findAnchor({ kind: "element", locator: "#title", quote: "Cache invalidation" });
    expect(hit?.el).toBe(document.getElementById("title"));
  });

  it("falls back to the quote when the locator no longer matches", () => {
    const core = makeCore();
    const hit = core.findAnchor({ kind: "cell", locator: "#gone", quote: "Write-through purge" });
    expect(hit?.el.textContent).toBe("Write-through purge");
    expect(hit?.el.localName).toBe("td");
  });

  it("re-finds a text anchor by quote, preferring the occurrence whose prefix matches", () => {
    document.body.innerHTML = "<p>alpha beta gamma</p><p>delta beta epsilon</p>";
    const core = makeCore();
    const hit = core.findAnchor({ kind: "text", locator: "#gone", quote: "beta", prefix: "delta", suffix: "epsilon" });
    expect(hit).not.toBeNull();
    expect(hit!.el.textContent).toBe("delta beta epsilon");
    expect(hit!.range?.toString()).toBe("beta");
  });

  it("finds a diagram node by id and a link by href", () => {
    const core = makeCore();
    expect(core.findAnchor({ kind: "diagram-node", locator: "#x", quote: "renamed", nodeId: "AuthGate" })?.el.id).toBe("flowchart-AuthGate-1");
    expect(core.findAnchor({ kind: "link", locator: "#x", quote: "the RFC", href: "https://example.com/rfc" })?.el.id).toBe("rfc");
  });

  it("returns null for an anchor that is not on the page (→ 'not found in this version')", () => {
    const core = makeCore();
    expect(core.findAnchor({ kind: "text", locator: "#title", quote: "nowhere on this page" })).toBeNull();
    expect(core.findAnchor({ kind: "element", locator: "#gone", quote: "nowhere either" })).toBeNull();
  });

  it("findQuote scores prefix and suffix", () => {
    const core = makeCore();
    const text = "a beta x a beta y";
    expect(core.findQuote(text, "beta", "a", "y")).toBe(text.lastIndexOf("beta"));
    expect(core.findQuote(text, "beta")).toBe(text.indexOf("beta"));
    expect(core.findQuote(text, "zeta")).toBe(-1);
  });
});

describe("annotator main — event wiring", () => {
  let uninstall: () => void;
  let posted: any[];
  beforeEach(() => {
    posted = [];
    // `parent` is the test window itself, so `event.source === parent` holds
    // for messages the test posts as the parent.
    const fakeParent = window;
    vi.spyOn(window, "postMessage").mockImplementation(((msg: unknown) => {
      posted.push(msg);
    }) as typeof window.postMessage);
    uninstall = new Function("document", "window", "parent", "core", ANNOTATOR_MAIN_SOURCE)(
      document,
      window,
      fakeParent,
      makeCore(),
    ) as () => void;
  });
  afterEach(() => {
    uninstall();
    vi.restoreAllMocks();
  });

  const anchors = () => posted.filter((m) => m?.dp === "anchor").map((m) => m.anchor);

  it("announces itself to the parent with {dp:'ready'}", () => {
    // Immediately when the document is already complete, else on load.
    if (!posted.some((m) => m?.dp === "ready")) window.dispatchEvent(new Event("load"));
    expect(posted.some((m) => m?.dp === "ready")).toBe(true);
  });

  it("a link click is prevented (never navigates) and posts a link anchor", () => {
    const link = document.getElementById("rfc")!;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(anchors()).toEqual([expect.objectContaining({ kind: "link", href: "https://example.com/rfc" })]);
  });

  it("still prevents link navigation when pointing is switched off", () => {
    window.dispatchEvent(new MessageEvent("message", { data: { dp: "mode", annotate: false }, source: window }));
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("rfc")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(anchors()).toEqual([]);
  });

  it("a cell click posts a cell anchor", () => {
    document.querySelectorAll("tbody td")[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(anchors()[0]).toMatchObject({ kind: "cell", table: { row: "TTL expiry", col: "Staleness" } });
  });

  it("draws numbered pins from {dp:'pins'} with textContent and reports which were found", () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          dp: "pins",
          anchors: [
            { kind: "element", locator: "#title", quote: "Cache invalidation" },
            { kind: "text", locator: "#title", quote: "<img src=x onerror=alert(1)>" },
          ],
        },
        source: window,
      }),
    );
    const status = posted.find((m) => m?.dp === "pins-status");
    expect(status.found).toEqual([true, false]);
    const pins = document.querySelectorAll("dp-annotator-pin");
    expect(pins).toHaveLength(1);
    expect(pins[0]!.textContent).toBe("1");
    // Nothing the parent sent was parsed as HTML.
    expect(document.querySelector("img")).toBeNull();
  });

  it("ignores messages that do not come from the parent", () => {
    const other = {} as unknown as Window;
    window.dispatchEvent(
      new MessageEvent("message", { data: { dp: "pins", anchors: [{ kind: "element", locator: "#title", quote: "" }] }, source: other as any }),
    );
    expect(posted.some((m) => m?.dp === "pins-status")).toBe(false);
  });
});

describe("annotator script string", () => {
  it("calls preventDefault on link clicks and posts to the parent with targetOrigin '*'", () => {
    expect(ANNOTATOR_SCRIPT).toContain("preventDefault");
    expect(ANNOTATOR_SCRIPT).toContain('parent.postMessage(msg, "*")');
  });

  it("never builds DOM from strings (no innerHTML / insertAdjacentHTML / document.write)", () => {
    expect(ANNOTATOR_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("can be inlined in a <script> tag (no closing script tag inside)", () => {
    expect(ANNOTATOR_SCRIPT.toLowerCase()).not.toContain("</script");
  });

  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(ANNOTATOR_SCRIPT)).not.toThrow();
  });
});
