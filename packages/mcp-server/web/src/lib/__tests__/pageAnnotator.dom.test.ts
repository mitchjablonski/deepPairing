/**
 * #680 slice 2 — the annotator script, evaluated from the EXACT shipped source
 * strings: its pure helpers (locator building, anchors for each kind, quote
 * extraction, re-finding) and its event wiring (link clicks never navigate,
 * clicks and selections post anchors to the parent, pins drawn with textContent
 * only and reported back, messages from anyone but the parent ignored).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HtmlAnchorSchema, PAGE_CSP_DIRECTIVES, PAGE_ERROR_CLASSES, PAGE_RESOURCE_KEYS } from "@deeppairing/shared";
import { ANNOTATOR_CORE_SOURCE, ANNOTATOR_MAIN_SOURCE, ANNOTATOR_SCRIPT } from "../pageAnnotator";
import { clippedText as diffClippedText, TEXT_SKIP_SELECTOR } from "../pageVersionDiff";

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

  it("findQuote scores prefix and suffix, and reports a tie as not found", () => {
    const core = makeCore();
    const text = "a beta x a beta y";
    expect(core.findQuote(text, "beta", "a", "y")).toBe(text.lastIndexOf("beta"));
    expect(core.findQuote(text, "beta", "a")).toBe(-1); // both occurrences equally supported
    expect(core.findQuote(text, "beta")).toBe(-1);
    expect(core.findQuote("only one beta here", "beta")).toBe("only one ".length);
    expect(core.findQuote(text, "zeta")).toBe(-1);
  });

  it("REGRESSION: after a row reorder the old locator resolves to a duplicate cell — the saved row header wins", () => {
    // v1: the anchored cell was "None" in the "Write-through purge" row (row 2).
    const v1Anchor = {
      kind: "cell",
      locator: "body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(2) > td:nth-of-type(2)",
      quote: "None",
      table: { row: "Write-through purge", col: "Staleness" },
    };
    // v2: a new row was inserted above, and it ALSO says "None". The old locator
    // now points at the wrong row's identical-looking cell.
    document.body.innerHTML =
      "<table><thead><tr><th>Strategy</th><th>Staleness</th></tr></thead><tbody>" +
      "<tr><td>TTL expiry</td><td>Up to 60s</td></tr>" +
      "<tr><td>Event bus purge</td><td>None</td></tr>" +
      "<tr><td>Write-through purge</td><td>None</td></tr></tbody></table>";
    const core = makeCore();
    const wrong = document.querySelector(v1Anchor.locator)!;
    expect(wrong.previousElementSibling!.textContent).toBe("Event bus purge");
    const hit = core.findAnchor(v1Anchor);
    expect(hit).not.toBeNull();
    expect(hit!.el.previousElementSibling!.textContent).toBe("Write-through purge");
  });

  it("reports not found when two candidates are equally supported", () => {
    document.body.innerHTML = "<table><tr><th>A</th></tr><tr><td>same</td></tr><tr><td>same</td></tr></table>";
    const core = makeCore();
    // No usable locator, no row header that tells them apart: a guess would be wrong half the time.
    expect(core.findAnchor({ kind: "cell", locator: "#gone", quote: "same", table: { col: "A" } })).toBeNull();
  });

  it("rejects a locator hit whose node id or href disagrees with the saved one", () => {
    document.body.innerHTML =
      "<svg><g class=\"node\" id=\"flowchart-Cache-1\"><text>Gate</text></g><g class=\"node\" id=\"flowchart-Auth-2\"><text>Gate</text></g></svg>" +
      "<a id=\"l1\" href=\"https://a.example\">docs</a><a id=\"l2\" href=\"https://b.example\">docs</a>";
    const core = makeCore();
    expect(core.findAnchor({ kind: "diagram-node", locator: "#flowchart-Cache-1", quote: "Gate", nodeId: "Auth" })?.el.id).toBe("flowchart-Auth-2");
    expect(core.findAnchor({ kind: "link", locator: "#l1", quote: "docs", href: "https://b.example" })?.el.id).toBe("l2");
  });

  it("a stale equal-text wrapper at the old locator cannot suppress the real link", () => {
    document.body.innerHTML = "<div id=\"w\"><a href=\"https://b.example\">docs</a></div><p>more</p>";
    const core = makeCore();
    const hit = core.findAnchor({ kind: "link", locator: "#w", quote: "docs", href: "https://b.example" });
    expect(hit?.el.localName).toBe("a");
  });

  it("an element locator wins over an equal-text descendant found by quote", () => {
    const core = makeCore();
    const hit = core.findAnchor({ kind: "element", locator: "div[data-testid=\"card\"]", quote: "Card body" });
    expect(hit?.el.getAttribute("data-testid")).toBe("card");
  });

  it("a text anchor uses prefix/suffix before the locator", () => {
    document.body.innerHTML = "<p id=\"a\">one beta two</p><p id=\"b\">three beta four</p>";
    const core = makeCore();
    // The saved locator points at #a, but the saved context says #b.
    const hit = core.findAnchor({ kind: "text", locator: "#a", quote: "beta", prefix: "three", suffix: "four" });
    expect(hit?.el.id).toBe("b");
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

  // --- #714 gap 7: pin colours, clickable badges, hover previews ----------
  const pinsMsg = (extra: Record<string, unknown> = {}) =>
    new MessageEvent("message", {
      data: {
        dp: "pins",
        anchors: [
          { kind: "element", locator: "#title", quote: "Cache invalidation" },
          { kind: "element", locator: ".intro", quote: "You can pick one of three strategies for the session cache." },
        ],
        states: ["open", "addressed"],
        ids: ["c_open", "c_done"],
        ...extra,
      },
      source: window,
    });
  const badges = () => Array.from(document.querySelectorAll("dp-annotator-badge")) as HTMLElement[];
  /** Real browsers hit-test: give the DOM an elementsFromPoint (plain page
   *  text under every badge unless `under` says otherwise) and on-screen
   *  boxes. Without it badges stay inert (the conservative fallback). */
  function hitTesting(under: () => Element = () => document.body) {
    (document as any).elementsFromPoint = () => [under()];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 40, y: 40, left: 40, top: 40, right: 58, bottom: 58, width: 18, height: 18, toJSON: () => ({}),
    } as DOMRect);
  }
  afterEach(() => {
    delete (document as any).elementsFromPoint;
  });

  it("colours each pin by the state the parent sent: open amber, addressed greyed", () => {
    window.dispatchEvent(pinsMsg());
    const pins = Array.from(document.querySelectorAll("dp-annotator-pin")) as HTMLElement[];
    expect(pins.map((p) => p.getAttribute("data-dp-pin-state"))).toEqual(["open", "addressed"]);
    expect(pins[0]!.style.getPropertyValue("outline")).toContain("solid");
    expect(pins[1]!.style.getPropertyValue("outline")).toContain("dashed");
    expect(badges()[0]!.style.getPropertyValue("background")).not.toBe(badges()[1]!.style.getPropertyValue("background"));
    // An unknown state reads as open; the layer and pin outlines never take clicks.
    window.dispatchEvent(pinsMsg({ states: ["bogus", 7] }));
    expect(Array.from(document.querySelectorAll("dp-annotator-pin")).map((p) => p.getAttribute("data-dp-pin-state"))).toEqual(["open", "open"]);
    expect((document.querySelector("dp-annotator-layer") as HTMLElement).style.getPropertyValue("pointer-events")).toBe("none");
    for (const p of document.querySelectorAll("dp-annotator-pin")) expect((p as HTMLElement).style.getPropertyValue("pointer-events")).toBe("none");
  });

  it("a click on a pin's badge posts {dp:'pin-click', id} and no anchor; the page under it is untouched", () => {
    hitTesting();
    window.dispatchEvent(pinsMsg());
    const pageClick = vi.fn();
    document.body.addEventListener("click", pageClick);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    badges()[1]!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(posted.filter((m) => m?.dp === "pin-click")).toEqual([{ dp: "pin-click", id: "c_done" }]);
    expect(anchors()).toEqual([]);
    expect(pageClick).not.toHaveBeenCalled();
    document.body.removeEventListener("click", pageClick);
  });

  it("badges are hit targets only while pointing is on and page scripts aren't running", () => {
    hitTesting();
    window.dispatchEvent(pinsMsg());
    expect(badges().map((b) => b.style.getPropertyValue("pointer-events"))).toEqual(["auto", "auto"]);
    window.dispatchEvent(new MessageEvent("message", { data: { dp: "mode", annotate: false, scripts: false }, source: window }));
    expect(badges().map((b) => b.style.getPropertyValue("pointer-events"))).toEqual(["none", "none"]);
    window.dispatchEvent(new MessageEvent("message", { data: { dp: "mode", annotate: true, scripts: true }, source: window }));
    expect(badges().map((b) => b.style.getPropertyValue("pointer-events"))).toEqual(["none", "none"]);
    // Even a click that still lands on a badge (e.g. dispatched) posts nothing then.
    badges()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted.filter((m) => m?.dp === "pin-click")).toEqual([]);
    window.dispatchEvent(new MessageEvent("message", { data: { dp: "mode", annotate: true, scripts: false }, source: window }));
    expect(badges().map((b) => b.style.getPropertyValue("pointer-events"))).toEqual(["auto", "auto"]);
  });

  it("a pin without a valid id gets no hit target", () => {
    hitTesting();
    window.dispatchEvent(pinsMsg({ ids: ["", "x".repeat(129)] }));
    expect(badges().map((b) => b.style.getPropertyValue("pointer-events"))).toEqual(["none", "none"]);
    badges()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted.filter((m) => m?.dp === "pin-click")).toEqual([]);
  });

  it("an authored element named like our badge is never treated as a pin", () => {
    hitTesting();
    window.dispatchEvent(pinsMsg());
    const fake = document.createElement("dp-annotator-badge");
    fake.setAttribute("data-dp-annotator", "");
    fake.textContent = "1";
    document.body.appendChild(fake);
    fake.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted.filter((m) => m?.dp === "pin-click")).toEqual([]);
  });

  it("hovering a badge posts {dp:'pin-hover', id, x, y}; moving off posts id:null (never comment text)", () => {
    hitTesting();
    window.dispatchEvent(pinsMsg());
    badges()[0]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 3, clientY: 4 }));
    const hovers = () => posted.filter((m) => m?.dp === "pin-hover");
    expect(hovers()).toEqual([{ dp: "pin-hover", id: "c_open", x: 40, y: 58 }]);
    // Moving within the same badge doesn't re-post.
    badges()[0]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(hovers()).toHaveLength(1);
    document.getElementById("title")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(hovers().pop()).toEqual({ dp: "pin-hover", id: null });
  });

  it("Cmd/Ctrl-click on a badge passes through (no pin click); holding the key makes badges inert", () => {
    hitTesting();
    window.dispatchEvent(pinsMsg());
    badges()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    badges()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    expect(posted.filter((m) => m?.dp === "pin-click")).toEqual([]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    expect(badges().map((b) => b.style.getPropertyValue("pointer-events"))).toEqual(["none", "none"]);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    expect(badges().map((b) => b.style.getPropertyValue("pointer-events"))).toEqual(["auto", "auto"]);
    // A pointer move with the modifier held does the same.
    document.getElementById("title")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, metaKey: true }));
    expect(badges()[0]!.style.getPropertyValue("pointer-events")).toBe("none");
  });

  it("the badge sits fully outside the anchored element's top-left corner", () => {
    window.dispatchEvent(pinsMsg());
    expect(badges()[0]!.style.getPropertyValue("left")).toBe("-20px");
    expect(badges()[0]!.style.getPropertyValue("top")).toBe("-20px");
  });

  it("without hit-testing (no elementsFromPoint) every badge stays inert: what lies under it is unknown", () => {
    window.dispatchEvent(pinsMsg());
    expect(badges().map((b) => b.style.getPropertyValue("pointer-events"))).toEqual(["none", "none"]);
    badges()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted.filter((m) => m?.dp === "pin-click")).toEqual([]);
  });

  it("with hit-testing, a badge over a native control (here an input) stays inert; over plain text it is live", () => {
    document.body.innerHTML = "<p id=\"a\">Alpha</p><input id=\"field\"><p id=\"b\">Beta</p>";
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 40, y: 40, left: 40, top: 40, right: 58, bottom: 58, width: 18, height: 18, toJSON: () => ({}),
    } as DOMRect);
    let under: Element = document.getElementById("field")!;
    (document as any).elementsFromPoint = () => [under];
    try {
      const send = () => window.dispatchEvent(
        new MessageEvent("message", {
          data: { dp: "pins", anchors: [{ kind: "element", locator: "#a", quote: "Alpha" }], states: ["open"], ids: ["c_a"] },
          source: window,
        }),
      );
      send();
      expect(badges()[0]!.style.getPropertyValue("pointer-events")).toBe("none");
      under = document.getElementById("b")!;
      send();
      expect(badges()[0]!.style.getPropertyValue("pointer-events")).toBe("auto");
    } finally {
      delete (document as any).elementsFromPoint;
      rect.mockRestore();
    }
  });

  it("{dp:'focus', anchor, block:'end'} scrolls the frame itself so the spot sits ~24px above its bottom edge", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { dp: "focus", anchor: { kind: "element", locator: "#title", quote: "Cache invalidation" }, block: "end" },
        source: window,
      }),
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // Bottom of the spot lands 24px above the frame's bottom edge.
    const r = document.getElementById("title")!.getBoundingClientRect();
    expect(scrollTo).toHaveBeenLastCalledWith(0, Math.max(0, r.bottom - (window.innerHeight - 24)));
    // A bogus anchor does nothing.
    window.dispatchEvent(new MessageEvent("message", { data: { dp: "focus", anchor: "nope", block: "end" }, source: window }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("re-resolves after the page changes: a removed target reports not found, without a new pins message", async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { dp: "pins", anchors: [{ kind: "element", locator: "#title", quote: "Cache invalidation" }] }, source: window }),
    );
    expect(posted.filter((m) => m?.dp === "pins-status").map((m) => m.found)).toEqual([[true]]);
    document.getElementById("title")!.remove();
    await new Promise((r) => setTimeout(r, 300));
    expect(posted.filter((m) => m?.dp === "pins-status").map((m) => m.found)).toEqual([[true], [false]]);
    expect(document.querySelectorAll("dp-annotator-pin")).toHaveLength(0);
  });

  it("reports found states again after a resize", async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { dp: "pins", anchors: [{ kind: "element", locator: "#gone", quote: "Brand new heading" }] }, source: window }),
    );
    expect(posted.filter((m) => m?.dp === "pins-status").map((m) => m.found)).toEqual([[false]]);
    const h = document.createElement("h2");
    h.textContent = "Brand new heading";
    document.body.prepend(h);
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => setTimeout(r, 300));
    expect(posted.filter((m) => m?.dp === "pins-status").map((m) => m.found).pop()).toEqual([true]);
  });

  it("focus re-resolves the target instead of using a cached node", () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { dp: "pins", anchors: [{ kind: "element", locator: "#title", quote: "Cache invalidation" }] }, source: window }),
    );
    // The page re-renders the heading: same content, new node.
    const old = document.getElementById("title")!;
    const fresh = document.createElement("h1");
    fresh.id = "title";
    fresh.textContent = "Cache invalidation";
    old.replaceWith(fresh);
    const spy = vi.fn();
    (fresh as any).scrollIntoView = spy;
    (old as any).scrollIntoView = vi.fn();
    window.dispatchEvent(new MessageEvent("message", { data: { dp: "focus", index: 0 }, source: window }));
    expect(spy).toHaveBeenCalled();
    expect((old as any).scrollIntoView).not.toHaveBeenCalled();
  });

  it("an inner scroll container's scroll redraws the pins (capture phase, coalesced)", async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { dp: "pins", anchors: [{ kind: "element", locator: "#title", quote: "Cache invalidation" }] }, source: window }),
    );
    const before = document.querySelector("dp-annotator-pin");
    expect(before).not.toBeNull();
    const inner = document.querySelector("section")!;
    for (let i = 0; i < 5; i++) inner.dispatchEvent(new Event("scroll")); // scroll does not bubble
    await new Promise((r) => setTimeout(r, 300));
    const after = document.querySelector("dp-annotator-pin");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("drawing pins does not trigger its own redraw loop", async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { dp: "pins", anchors: [{ kind: "element", locator: "#title", quote: "Cache invalidation" }] }, source: window }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(posted.filter((m) => m?.dp === "pins-status")).toHaveLength(1);
  });

  it("ignores messages that do not come from the parent", () => {
    const other = {} as unknown as Window;
    window.dispatchEvent(
      new MessageEvent("message", { data: { dp: "pins", anchors: [{ kind: "element", locator: "#title", quote: "" }] }, source: other as any }),
    );
    expect(posted.some((m) => m?.dp === "pins-status")).toBe(false);
  });
});

// --- #714: pointing never breaks the page's own navigation ------------------

const NAV_PAGE =
  "<nav><a id=\"toc\" href=\"#details\">Details</a> <a id=\"toc-top\" href=\"#top\">Top</a></nav>" +
  "<details id=\"more\"><summary id=\"sum\">More</summary><p id=\"hidden-p\">Hidden body</p></details>" +
  "<details><summary>Closed</summary><h2 id=\"details\">Details section</h2></details>" +
  "<div class=\"tabs\">" +
  "<input type=\"radio\" name=\"tab\" id=\"tab-a\" checked><label id=\"lab-a\" for=\"tab-a\">Tab A</label>" +
  "<input type=\"radio\" name=\"tab\" id=\"tab-b\"><label id=\"lab-b\" for=\"tab-b\">Tab B</label>" +
  "</div>" +
  "<p id=\"plain\">A plain paragraph.</p>" +
  "<a id=\"ext\" href=\"https://example.com/out\">Outside</a>" +
  "<a id=\"rel\" href=\"other.html#sec\">Another doc</a>";

describe("annotator main — pointing keeps the page navigable (#714)", () => {
  let uninstall: () => void;
  let posted: any[];
  let scrolled: Element[];
  const origScroll = Element.prototype.scrollIntoView;
  beforeEach(() => {
    document.body.innerHTML = NAV_PAGE;
    posted = [];
    scrolled = [];
    // A fake scroll that records which element was asked to scroll into view.
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    vi.spyOn(window, "postMessage").mockImplementation(((msg: unknown) => {
      posted.push(msg);
    }) as typeof window.postMessage);
    uninstall = new Function("document", "window", "parent", "core", ANNOTATOR_MAIN_SOURCE)(
      document,
      window,
      window,
      makeCore(),
    ) as () => void;
  });
  afterEach(() => {
    uninstall();
    Element.prototype.scrollIntoView = origScroll;
    vi.restoreAllMocks();
  });

  const anchors = () => posted.filter((m) => m?.dp === "anchor").map((m) => m.anchor);
  const click = (el: Element, init: MouseEventInit = {}) => {
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    return ev;
  };
  const setMode = (annotate: boolean) =>
    window.dispatchEvent(new MessageEvent("message", { data: { dp: "mode", annotate }, source: window }));

  it("a same-document #hash link scrolls to its target without creating an anchor (and never navigates)", () => {
    const ev = click(document.getElementById("toc")!);
    // The browser's own handling is cancelled: a srcdoc frame resolves "#x"
    // against the companion's URL, so letting it run would leave the page.
    expect(ev.defaultPrevented).toBe(true);
    expect(scrolled).toEqual([document.getElementById("details")]);
    expect(anchors()).toEqual([]);
  });

  it("scrolling to a target inside a closed <details> opens it", () => {
    const target = document.getElementById("details")!;
    const details = target.closest("details")!;
    expect(details.open).toBe(false);
    click(document.getElementById("toc")!);
    expect(details.open).toBe(true);
  });

  it("a hash link still scrolls with pointing switched off", () => {
    setMode(false);
    click(document.getElementById("toc")!);
    expect(scrolled).toEqual([document.getElementById("details")]);
    expect(anchors()).toEqual([]);
  });

  it("a summary click toggles its details (default action kept, no anchor)", () => {
    const sum = document.getElementById("sum")!;
    const details = document.getElementById("more") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const ev = click(sum);
    expect(ev.defaultPrevented).toBe(false);
    expect(details.open).toBe(true);
    expect(anchors()).toEqual([]);
  });

  it("a label click switches its radio (CSS-only tabs keep working, no anchor)", () => {
    const a = document.getElementById("tab-a") as HTMLInputElement;
    const b = document.getElementById("tab-b") as HTMLInputElement;
    expect(a.checked).toBe(true);
    const ev = click(document.getElementById("lab-b")!);
    expect(ev.defaultPrevented).toBe(false);
    expect(b.checked).toBe(true);
    expect(a.checked).toBe(false);
    expect(anchors()).toEqual([]);
  });

  it("a radio click itself switches, no anchor", () => {
    const b = document.getElementById("tab-b") as HTMLInputElement;
    const ev = click(b);
    expect(ev.defaultPrevented).toBe(false);
    expect(b.checked).toBe(true);
    expect(anchors()).toEqual([]);
  });

  it("Alt-click on a hash link points at it instead of scrolling", () => {
    const ev = click(document.getElementById("toc")!, { altKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(scrolled).toEqual([]);
    expect(anchors()).toEqual([expect.objectContaining({ kind: "link", href: "#details", quote: "Details" })]);
    expect(HtmlAnchorSchema.safeParse(anchors()[0]).success).toBe(true);
  });

  it("Alt-click on a summary points at it and leaves the details closed", () => {
    const details = document.getElementById("more") as HTMLDetailsElement;
    const ev = click(document.getElementById("sum")!, { altKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(details.open).toBe(false);
    expect(anchors()).toEqual([expect.objectContaining({ kind: "element", quote: "More" })]);
  });

  it("Alt-click on a label points at it and does not switch the radio", () => {
    const a = document.getElementById("tab-a") as HTMLInputElement;
    const b = document.getElementById("tab-b") as HTMLInputElement;
    const ev = click(document.getElementById("lab-b")!, { altKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(a.checked).toBe(true);
    expect(b.checked).toBe(false);
    expect(anchors()).toEqual([expect.objectContaining({ kind: "element", quote: "Tab B" })]);
  });

  it("an external link is still never navigated and becomes a link anchor", () => {
    const ev = click(document.getElementById("ext")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(scrolled).toEqual([]);
    expect(anchors()).toEqual([expect.objectContaining({ kind: "link", href: "https://example.com/out" })]);
  });

  it("a cross-document link with a fragment is not treated as same-document", () => {
    const ev = click(document.getElementById("rel")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(scrolled).toEqual([]);
    expect(anchors()).toEqual([expect.objectContaining({ kind: "link", href: "other.html#sec" })]);
  });

  it("external links never navigate under any modifier or mode", () => {
    const ext = document.getElementById("ext")!;
    expect(click(ext, { altKey: true }).defaultPrevented).toBe(true);
    expect(click(ext, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(click(ext, { metaKey: true }).defaultPrevented).toBe(true);
    setMode(false);
    expect(click(ext).defaultPrevented).toBe(true);
  });

  it("an ordinary element click still points in one click", () => {
    const ev = click(document.getElementById("plain")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(anchors()).toEqual([expect.objectContaining({ kind: "element", quote: "A plain paragraph." })]);
  });

  it("holding Cmd/Ctrl lets a click through to the page without pointing", () => {
    expect(click(document.getElementById("plain")!, { metaKey: true }).defaultPrevented).toBe(false);
    expect(click(document.getElementById("plain")!, { ctrlKey: true }).defaultPrevented).toBe(false);
    // ...and a held-Ctrl external link becomes no anchor (but still never navigates).
    expect(click(document.getElementById("ext")!, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(anchors()).toEqual([]);
  });

  it("REVIEW: Cmd/Ctrl+I is left to the page while typing in its fields, on autorepeat, and after Run", () => {
    const input = document.createElement("input");
    const ta = document.createElement("textarea");
    const ce = document.createElement("div");
    ce.contentEditable = "true";
    document.body.append(input, ta, ce);
    for (const el of [input, ta, ce]) {
      const ev = new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    const rep = new KeyboardEvent("keydown", { key: "i", ctrlKey: true, repeat: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(rep);
    expect(rep.defaultPrevented).toBe(false);
    window.dispatchEvent(new MessageEvent("message", { data: { dp: "mode", annotate: true, scripts: true }, source: window }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(posted.filter((m) => m?.dp === "toggle-pointing")).toHaveLength(0);
  });

  const svgLink = () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const a = document.createElementNS("http://www.w3.org/2000/svg", "a");
    a.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "https://example.com/svg-out");
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.textContent = "SVG link";
    a.appendChild(text);
    svg.appendChild(a);
    document.body.appendChild(svg);
    return text;
  };

  it("REVIEW: an SVG xlink:href link never navigates with pointing off, with Ctrl/Cmd held, or on middle-click", () => {
    const text = svgLink();
    setMode(false);
    expect(click(text).defaultPrevented).toBe(true);
    setMode(true);
    expect(click(text, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(click(text, { metaKey: true }).defaultPrevented).toBe(true);
    const aux = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    text.dispatchEvent(aux);
    expect(aux.defaultPrevented).toBe(true);
    expect(anchors()).toEqual([]);
  });

  it("REVIEW: a plain click on an SVG xlink link (pointing on) is prevented and points at it", () => {
    const text = svgLink();
    expect(click(text).defaultPrevented).toBe(true);
    expect(anchors()).toHaveLength(1);
    expect(HtmlAnchorSchema.safeParse(anchors()[0]).success).toBe(true);
  });

  it("REVIEW: a hashbang or target-less #hash link points at the link instead of doing nothing", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      "<a id=\"bang\" href=\"#!/route\">Route</a><a id=\"stale\" href=\"#gone\">Gone</a>",
    );
    expect(click(document.getElementById("bang")!).defaultPrevented).toBe(true);
    expect(click(document.getElementById("stale")!).defaultPrevented).toBe(true);
    expect(scrolled).toEqual([]);
    expect(anchors().map((a) => a.href)).toEqual(["#!/route", "#gone"]);
    // "#top" with no such id still scrolls to the top rather than anchoring.
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    click(document.getElementById("toc-top")!);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(anchors()).toHaveLength(2);
  });

  it("REVIEW: before Run a button has no action, so a click on it points; after Run it passes through", () => {
    document.body.insertAdjacentHTML("beforeend", "<button id=\"opt\">Option A</button><input id=\"sub\" type=\"submit\" value=\"Go\">");
    expect(click(document.getElementById("opt")!).defaultPrevented).toBe(true);
    expect(click(document.getElementById("sub")!).defaultPrevented).toBe(true);
    expect(anchors()).toHaveLength(2);
    expect(anchors()[0]).toMatchObject({ kind: "element", quote: "Option A" });
    window.dispatchEvent(new MessageEvent("message", { data: { dp: "mode", annotate: true, scripts: true }, source: window }));
    expect(click(document.getElementById("opt")!).defaultPrevented).toBe(false);
    expect(anchors()).toHaveLength(2);
  });

  it("REVIEW: a label-wrapped card: block content points, the label text and its control switch", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      "<label id=\"card\"><input type=\"radio\" name=\"plan\" id=\"plan-a\"> <b id=\"card-title\">Plan A</b>" +
        "<div><p id=\"card-body\">Cheaper, slower rollout.</p></div></label>",
    );
    const radio = document.getElementById("plan-a") as HTMLInputElement;
    const body = click(document.getElementById("card-body")!);
    expect(body.defaultPrevented).toBe(true);
    expect(radio.checked).toBe(false);
    expect(anchors()).toEqual([expect.objectContaining({ kind: "element", quote: "Cheaper, slower rollout." })]);
    expect(click(document.getElementById("card-title")!).defaultPrevented).toBe(false);
    expect(radio.checked).toBe(true);
    radio.checked = false;
    expect(click(radio).defaultPrevented).toBe(false);
    expect(radio.checked).toBe(true);
    expect(anchors()).toHaveLength(1);
  });

  it("REVIEW: an authored link carrying the annotator's marker attribute is still never navigated", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      "<a id=\"fake-own\" data-dp-annotator href=\"https://example.com/escape\"><span id=\"fake-inner\">Escape</span></a>" +
        "<dp-annotator-layer data-dp-annotator><a id=\"fake-layer\" href=\"https://example.com/escape2\">Escape 2</a></dp-annotator-layer>",
    );
    for (const id of ["fake-own", "fake-inner", "fake-layer"]) {
      const el = document.getElementById(id)!;
      for (const mods of [{}, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
        setMode(true);
        expect(click(el, mods).defaultPrevented).toBe(true);
        setMode(false);
        expect(click(el, mods).defaultPrevented).toBe(true);
      }
      const aux = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
      el.dispatchEvent(aux);
      expect(aux.defaultPrevented).toBe(true);
    }
    // Not mistaken for our own UI either: a pointing click anchors it.
    setMode(true);
    click(document.getElementById("fake-own")!);
    expect(anchors()).toContainEqual(expect.objectContaining({ kind: "link", href: "https://example.com/escape" }));
  });

  it("REVIEW: label block-ness is by computed display: a display:block span or a block custom element points", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      "<label><input type=\"radio\" name=\"p2\" id=\"p2-a\"> <span id=\"blk\" style=\"display:block\">Block span body</span>" +
        "<x-card id=\"xc\" style=\"display:block\">Custom card body</x-card><span id=\"inl\">Inline name</span></label>",
    );
    const radio = document.getElementById("p2-a") as HTMLInputElement;
    expect(click(document.getElementById("blk")!).defaultPrevented).toBe(true);
    expect(click(document.getElementById("xc")!).defaultPrevented).toBe(true);
    expect(radio.checked).toBe(false);
    expect(anchors().map((a) => a.quote)).toEqual(["Block span body", "Custom card body"]);
    expect(click(document.getElementById("inl")!).defaultPrevented).toBe(false);
    expect(radio.checked).toBe(true);
  });

  it("REVIEW: before Run a button inside a summary toggles its details instead of pointing", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      "<details id=\"bd\"><summary><button id=\"sb\" type=\"button\">Expand</button></summary><p>Body</p></details>",
    );
    const d = document.getElementById("bd") as HTMLDetailsElement;
    click(document.getElementById("sb")!);
    expect(d.open).toBe(true);
    click(document.getElementById("sb")!);
    expect(d.open).toBe(false);
    expect(anchors()).toEqual([]);
    // Alt-click still points at it.
    click(document.getElementById("sb")!, { altKey: true });
    expect(d.open).toBe(false);
    expect(anchors()).toEqual([expect.objectContaining({ quote: "Expand" })]);
  });

  it("Cmd/Ctrl+I inside the frame asks the parent to toggle pointing", () => {
    const ev = new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(posted.filter((m) => m?.dp === "toggle-pointing")).toHaveLength(1);
    // Plain "i" (typing) and Alt/Shift chords are left alone.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "I", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(posted.filter((m) => m?.dp === "toggle-pointing")).toHaveLength(1);
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

describe("annotator main — version change marks (#714 gap 2)", () => {
  let uninstall: () => void;
  let posted: any[];
  let scrolled: Element[];
  const origScroll = Element.prototype.scrollIntoView;
  beforeEach(() => {
    document.body.innerHTML = PAGE;
    posted = [];
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    vi.spyOn(window, "postMessage").mockImplementation(((msg: unknown) => {
      posted.push(msg);
    }) as typeof window.postMessage);
    uninstall = new Function("document", "window", "parent", "core", ANNOTATOR_MAIN_SOURCE)(
      document,
      window,
      window,
      makeCore(),
    ) as () => void;
  });
  afterEach(() => {
    uninstall();
    Element.prototype.scrollIntoView = origScroll;
    vi.restoreAllMocks();
  });

  const send = (data: unknown, source: unknown = window) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
  const statuses = () => posted.filter((m) => m?.dp === "changes-status").map((m) => m.found);
  const marks = [
    { kind: "changed", tag: "p", text: "Second bold paragraph.", occurrence: 0 },
    { kind: "added", tag: "tr", text: "Write-through purge | None", occurrence: 0 },
    { kind: "added", tag: "p", text: "Gone from this page", occurrence: 0 },
  ];

  it("draws change bars from {dp:'changes'} (textContent only) and reports which were found", () => {
    send({ dp: "changes", marks, show: true });
    const boxes = Array.from(document.querySelectorAll("dp-annotator-change"));
    expect(boxes.map((b) => b.getAttribute("data-dp-change-kind")).sort()).toEqual(["added", "changed"]);
    expect(boxes.every((b) => b.textContent === "+" || b.textContent === "~")).toBe(true);
    expect(statuses().at(-1)).toEqual([true, true, false]);
  });

  it("hides the bars when show is false, and drops malformed or spoofed marks", () => {
    send({ dp: "changes", marks, show: false });
    expect(document.querySelectorAll("dp-annotator-change")).toHaveLength(0);
    send({ dp: "changes", marks: [{ kind: "changed", tag: "p><img", text: "x", occurrence: 0 }, { kind: "evil", tag: "p", text: "First paragraph.", occurrence: 0 }, { kind: "added", tag: "p", text: "First paragraph.", occurrence: -1 }], show: true });
    expect(document.querySelectorAll("dp-annotator-change")).toHaveLength(0);
    expect(statuses().at(-1)).toEqual([false, false, false]);
    // From anyone but the parent: ignored.
    send({ dp: "changes", marks, show: true }, null);
    expect(document.querySelectorAll("dp-annotator-change")).toHaveLength(0);
  });

  it("navigates: {dp:'focus-change'} scrolls the frame to that change", () => {
    send({ dp: "changes", marks, show: true });
    send({ dp: "focus-change", index: 1 });
    expect(scrolled.at(-1)).toBe(document.querySelectorAll("tbody tr")[1]);
    send({ dp: "focus-change", index: 0 });
    expect(scrolled.at(-1)).toBe(document.querySelectorAll("section p")[1]);
    const before = scrolled.length;
    send({ dp: "focus-change", index: 2 }); // not on the page: nothing to scroll to
    send({ dp: "focus-change", index: 9 });
    expect(scrolled.length).toBe(before);
  });

  it("re-finds a mark by occurrence among same-text elements", () => {
    document.body.innerHTML = "<p>Same</p><p>Same</p><p>Same</p>";
    send({ dp: "changes", marks: [{ kind: "added", tag: "p", text: "Same", occurrence: 2 }], show: true });
    send({ dp: "focus-change", index: 0 });
    expect(scrolled.at(-1)).toBe(document.querySelectorAll("p")[2]);
  });
});

describe("annotator change marks — caching, ownership and parity (#714 gap 2 review)", () => {
  type ChildListRecord = {
    type: "childList";
    target: Node;
    addedNodes: Node[];
    removedNodes: Node[];
  };
  let uninstall: () => void;
  let posted: any[];
  let finds: number;
  let deliver: (records: ChildListRecord[]) => void;
  const observe = vi.fn<(target: Node, options: MutationObserverInit) => void>();
  const disconnect = vi.fn();
  class TestMutationObserver {
    observe = observe;
    disconnect = disconnect;
    constructor(callback: (records: ChildListRecord[]) => void) {
      // Keep a strong reference so the fixture can deliver observer records directly.
      deliver = callback;
    }
  }

  beforeEach(() => {
    document.body.innerHTML = PAGE;
    posted = [];
    finds = 0;
    observe.mockClear();
    disconnect.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("MutationObserver", TestMutationObserver);
    vi.spyOn(window, "postMessage").mockImplementation(((msg: unknown) => {
      posted.push(msg);
    }) as typeof window.postMessage);
    const core = makeCore() as any;
    const real = core.findChanges;
    core.findChanges = (list: unknown, cache: unknown) => { finds++; return real(list, cache); };
    uninstall = new Function("document", "window", "parent", "core", ANNOTATOR_MAIN_SOURCE)(document, window, window, core) as () => void;
    expect(observe).toHaveBeenCalledExactlyOnceWith(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
  });
  afterEach(() => {
    try {
      uninstall();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
  const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: window }));
  const change = (target: Node, addedNodes: Node[], removedNodes: Node[]) =>
    deliver([{ type: "childList", target, addedNodes, removedNodes }]);

  it("a scroll only re-places the bars; removing a matched node re-finds them", () => {
    const paragraph = document.querySelector("section p")!;
    const rect = vi.spyOn(paragraph, "getBoundingClientRect");
    send({ dp: "changes", marks: [{ kind: "moved", tag: "p", text: "First paragraph.", occurrence: 0 }], show: true });
    expect(finds).toBe(1);
    const box = document.querySelector("dp-annotator-change")!;
    expect(box.getAttribute("data-dp-change-kind")).toBe("moved");
    rect.mockClear();
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(119);
    expect(rect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rect).toHaveBeenCalledTimes(1);
    expect(finds).toBe(1);
    expect(document.querySelector("dp-annotator-change")).toBe(box);

    const section = paragraph.parentElement!;
    paragraph.remove();
    change(section, [], [paragraph]);
    expect(finds).toBe(1);
    vi.advanceTimersByTime(120);
    expect(finds).toBe(2);
    expect(posted.filter((m) => m?.dp === "changes-status").at(-1)?.found).toEqual([false]);
    expect(box.isConnected).toBe(false);
    expect(document.querySelector("dp-annotator-change")).toBeNull();
  });

  it("drawing bars never re-triggers a redraw (bars are ours by reference)", () => {
    const paragraph = document.querySelector("section p")!;
    const rect = vi.spyOn(paragraph, "getBoundingClientRect");
    send({ dp: "changes", marks: [{ kind: "added", tag: "p", text: "First paragraph.", occurrence: 0 }], show: true });
    const layer = document.querySelector("dp-annotator-layer")!;
    const box = layer.querySelector("dp-annotator-change")!;
    rect.mockClear();
    // Deliver both real insertions: the layer into the authored document and
    // the change bar into the layer.
    change(document.documentElement, [layer], []);
    change(layer, [box], []);
    vi.advanceTimersByTime(120);
    expect(rect).not.toHaveBeenCalled();
    expect(finds).toBe(1);
    expect(layer.querySelector("dp-annotator-change")).toBe(box);
  });

  it("a mutation inside authored [data-dp-annotator] content still invalidates the cache", () => {
    document.body.innerHTML = "<div data-dp-annotator><p>Authored</p></div>";
    send({ dp: "changes", marks: [{ kind: "changed", tag: "p", text: "Authored", occurrence: 0 }], show: true });
    expect(finds).toBe(1);
    const authored = document.body.querySelector("[data-dp-annotator]")!;
    const inserted = authored.appendChild(document.createElement("p"));
    inserted.textContent = "more";
    change(authored, [inserted], []);
    expect(finds).toBe(1);
    vi.advanceTimersByTime(120);
    expect(finds).toBe(2);
  });

  it("authored data-dp-annotator content is still found and marked", () => {
    document.body.innerHTML = "<p data-dp-annotator>Authored</p>";
    send({ dp: "changes", marks: [{ kind: "changed", tag: "p", text: "Authored", occurrence: 0 }], show: true });
    expect(posted.filter((m) => m?.dp === "changes-status").at(-1)?.found).toEqual([true]);
  });
});

describe("clippedText parity: annotator core vs companion diff (#714 gap 2)", () => {
  const FIXTURES = [
    "<p>  Hello   <b>bold</b>\n world </p>",
    "<table><tr><td>40</td><td></td><th>x</th></tr></table>",
    "<p>Ship<br>Monday</p>",
    "<figure><img alt=\"Latency chart\"></figure>",
    "<div><h3>Card</h3>Ship on <i>Monday</i></div>",
    "<div aria-label=\"Labelled\"></div>",
    "<p>a&nbsp;b &amp; c</p>",
    "<div><script>var x = 1;</script><style>p{}</style><noscript>ns</noscript><template>t</template><iframe>f</iframe>kept</div>",
    "<p data-dp-annotator>authored</p>",
    `<p>${"long ".repeat(100)}</p>`,
    "<table><tr><td></td><td></td><td>40</td></tr></table>",
    "<p>Budget <input value=\"40\"> <input type=submit> <input type=button value=\"Go\"> <input type=hidden value=\"h\"> <input type=checkbox value=\"c\"></p>",
  ];
  it("both read every fixture identically", () => {
    const core = makeCore() as any;
    for (const html of FIXTURES) {
      document.body.innerHTML = html;
      const el = document.body.firstElementChild!;
      expect(core.clippedText(el, 280)).toBe(diffClippedText(el, 280));
    }
  });
  it("skip lists are the same string", () => {
    expect((makeCore() as any).CHANGE_SKIP).toBe(TEXT_SKIP_SELECTOR);
  });
});

// --- #714 gaps 4+5: outline, asks, reading progress --------------------------

const OUTLINE_PAGE =
  "<header id=\"tldr\"><h1>Profile cache</h1><p>TL;DR: put Redis in front.</p></header>" +
  "<section id=\"options\"><h2>Options</h2><p id=\"opt-p\">Redis or LRU.</p>" +
  "<h3>Redis</h3><p id=\"redis-p\">About 15ms.</p></section>" +
  "<section id=\"asks\"><h2>What I need <em>from</em> you</h2>" +
  "<p id=\"decide-ttl\" data-dp-decision><strong>Decide:</strong> a 60s TTL,<br>or invalidate on write?</p>" +
  "<div id=\"ask-budget\" data-dp-question data-dp-decision>Is one more instance in budget?</div>" +
  "<p data-dp-question>An ask with no id</p></section>" +
  "<h4>Not in the outline</h4><h2>   </h2>" +
  "<template><h2>Inert</h2></template>";

describe("annotator core — outline and asks (#714 gaps 4+5)", () => {
  type OutlineCore = Core & {
    collectHeadings(): Array<{ el: Element; level: number; text: string; locator: string }>;
    collectAsks(): Array<{ el: Element; kind: string; text: string; locator: string; id?: string }>;
    sectionOf(el: Element, heads: Element[]): number;
    textPrefix(el: Element, max: number): string;
    OUTLINE: { max: number; text: number; asks: number; askText: number };
  };
  const core = () => makeCore() as OutlineCore;
  beforeEach(() => {
    document.body.innerHTML = OUTLINE_PAGE;
  });

  it("collects h1–h3 in document order with level, text and a locator that resolves (h4+, empty and inert headings skipped)", () => {
    const hs = core().collectHeadings();
    expect(hs.map((h) => [h.level, h.text])).toEqual([
      [1, "Profile cache"],
      [2, "Options"],
      [3, "Redis"],
      [2, "What I need from you"],
    ]);
    for (const h of hs) expect(document.querySelector(h.locator)).toBe(h.el);
  });

  it("bounds the outline: at most 200 headings, each at most 120 characters", () => {
    document.body.innerHTML = Array.from({ length: 260 }, (_, i) => `<h2>${"Heading " + i + " " + "x".repeat(200)}</h2>`).join("");
    const c = core();
    const hs = c.collectHeadings();
    expect(hs).toHaveLength(200);
    expect(hs.every((h) => h.text.length <= 120)).toBe(true);
    expect(hs[0]!.text.startsWith("Heading 0 x")).toBe(true);
  });

  it("collects asks: kind (decision wins), id, a text prefix that equals the element anchor's quote, and a locator", () => {
    const c = core();
    const asks = c.collectAsks();
    expect(asks.map((a) => ({ kind: a.kind, id: a.id, text: a.text, locator: a.locator }))).toEqual([
      { kind: "decision", id: "decide-ttl", text: "Decide: a 60s TTL,or invalidate on write?", locator: "#decide-ttl" },
      { kind: "decision", id: "ask-budget", text: "Is one more instance in budget?", locator: "#ask-budget" },
      { kind: "question", id: undefined, text: "An ask with no id", locator: expect.stringContaining("p:nth-of-type") },
    ]);
    // Same text a click on the element would quote, so a reply's pin re-finds.
    for (const a of asks) expect(a.text).toBe(c.anchorForTarget(a.el)!.quote.slice(0, 200));
    expect(document.querySelector(asks[2]!.locator)).toBe(asks[2]!.el);
  });

  it("bounds the asks: at most 50, text at most 200 characters, read without walking a huge subtree", () => {
    document.body.innerHTML = Array.from({ length: 70 }, (_, i) => `<p id="a${i}" data-dp-question>${"q".repeat(500)}</p>`).join("");
    const asks = core().collectAsks();
    expect(asks).toHaveLength(50);
    expect(asks.every((a) => a.text.length === 200)).toBe(true);
    const big = document.createElement("div");
    big.innerHTML = "<p>" + "word ".repeat(50_000) + "</p>";
    expect(core().textPrefix(big, 200)).toHaveLength(200);
  });

  it("sectionOf: the last heading at or before the element; a whole section belongs to its own heading; -1 above the first", () => {
    const c = core();
    const heads = c.collectHeadings().map((h) => h.el);
    expect(c.sectionOf(document.getElementById("opt-p")!, heads)).toBe(1);
    expect(c.sectionOf(document.getElementById("redis-p")!, heads)).toBe(2);
    expect(c.sectionOf(document.getElementById("decide-ttl")!, heads)).toBe(3);
    expect(c.sectionOf(heads[2]!, heads)).toBe(2);
    expect(c.sectionOf(document.getElementById("options")!, heads)).toBe(1);
    document.body.insertAdjacentHTML("afterbegin", "<p id=\"pre\">Before any heading</p>");
    expect(c.sectionOf(document.getElementById("pre")!, heads)).toBe(-1);
  });
});

describe("annotator main — outline, asks and reading progress (#714 gaps 4+5)", () => {
  let uninstall: () => void;
  let posted: any[];
  let scrolled: Element[];
  const origScroll = Element.prototype.scrollIntoView;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = OUTLINE_PAGE;
    posted = [];
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    vi.spyOn(window, "postMessage").mockImplementation(((msg: unknown) => {
      posted.push(msg);
    }) as typeof window.postMessage);
    uninstall = new Function("document", "window", "parent", "core", ANNOTATOR_MAIN_SOURCE)(document, window, window, makeCore()) as () => void;
    if (!posted.some((m) => m?.dp === "ready")) window.dispatchEvent(new Event("load"));
  });
  afterEach(() => {
    uninstall();
    Element.prototype.scrollIntoView = origScroll;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const send = (data: unknown, source: unknown = window) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
  const of = (dp: string) => posted.filter((m) => m?.dp === dp);

  it("posts the outline and the asks on ready, once each", () => {
    const outline = of("outline");
    expect(outline).toHaveLength(1);
    expect(outline[0].headings.map((h: any) => h.text)).toEqual(["Profile cache", "Options", "Redis", "What I need from you"]);
    expect(outline[0]).toMatchObject({ pins: [], changes: [] });
    expect(of("asks")).toHaveLength(1);
    expect(of("asks")[0].asks.map((a: any) => a.id ?? null)).toEqual(["decide-ttl", "ask-budget", null]);
    // An unchanged page reports nothing new.
    send({ dp: "pins", anchors: [] });
    vi.advanceTimersByTime(500);
    expect(of("outline")).toHaveLength(1);
    expect(of("asks")).toHaveLength(1);
  });

  it("maps each pin and each change mark to its section", () => {
    send({
      dp: "pins",
      anchors: [
        { kind: "element", locator: "#redis-p", quote: "About 15ms." },
        { kind: "element", locator: "#gone", quote: "Not on this page" },
        { kind: "text", locator: "#decide-ttl", quote: "invalidate on write" },
      ],
    });
    send({ dp: "changes", show: false, marks: [{ kind: "changed", tag: "p", text: "Redis or LRU.", occurrence: 0 }] });
    vi.advanceTimersByTime(300);
    expect(of("outline").at(-1)).toMatchObject({ pins: [2, -1, 3], changes: [1] });
  });

  it("reports, per pin, the innermost ask its element sits in (a child with its own id counts)", () => {
    document.getElementById("decide-ttl")!.insertAdjacentHTML("beforeend", " <em id=\"ttl-note\">60s</em>");
    return Promise.resolve().then(() => {
      send({
        dp: "pins",
        anchors: [
          { kind: "element", locator: "#ttl-note", quote: "60s" },
          { kind: "element", locator: "#redis-p", quote: "About 15ms." },
          { kind: "element", locator: "#ask-budget", quote: "Is one more instance in budget?" },
        ],
      });
      vi.advanceTimersByTime(300);
      expect(of("asks").at(-1).pinAsks).toEqual([0, -1, 1]);
    });
  });

  it("echoes the parent's pin-list key on pins-status and asks reports; a malformed key is dropped", () => {
    send({ dp: "pins", anchors: [{ kind: "element", locator: "#redis-p", quote: "About 15ms." }], key: "abc123:9" });
    vi.advanceTimersByTime(300);
    expect(of("pins-status").at(-1)).toEqual({ dp: "pins-status", found: [true], key: "abc123:9" });
    expect(of("asks").at(-1)).toMatchObject({ pinAsks: [-1], key: "abc123:9" });
    send({ dp: "pins", anchors: [{ kind: "element", locator: "#redis-p", quote: "About 15ms." }], key: "<img src=x>" });
    vi.advanceTimersByTime(300);
    expect(of("pins-status").at(-1)).toEqual({ dp: "pins-status", found: [true] });
    expect(of("asks").at(-1)).not.toHaveProperty("key");
  });

  it("re-reports after a relevant page mutation (debounced), never for its own layer", () => {
    document.querySelector("h3")!.textContent = "Redis (managed)";
    document.body.insertAdjacentHTML("beforeend", "<p id=\"late\" data-dp-question>Late ask?</p>");
    return Promise.resolve().then(() => {
      vi.advanceTimersByTime(300);
      expect(of("outline").at(-1).headings[2].text).toBe("Redis (managed)");
      expect(of("asks").at(-1).asks.map((a: any) => a.id ?? null)).toEqual(["decide-ttl", "ask-budget", null, "late"]);
    });
  });

  it("focus-heading scrolls to the heading (by index, re-checked against the locator) and opens details around it", () => {
    document.body.insertAdjacentHTML("beforeend", "<details><summary>More</summary><h2 id=\"deep\">Deep</h2></details>");
    return Promise.resolve().then(() => {
      vi.advanceTimersByTime(300);
      const heads = of("outline").at(-1).headings;
      const i = heads.findIndex((h: any) => h.text === "Deep");
      send({ dp: "focus-heading", index: i, locator: heads[i].locator });
      expect(scrolled.at(-1)).toBe(document.getElementById("deep"));
      expect(document.querySelector("details")!.open).toBe(true);
      send({ dp: "focus-heading", index: 1, locator: heads[1].locator });
      expect(scrolled.at(-1)!.textContent).toBe("Options");
      // A stale index falls back to the locator; a locator for a non-heading,
      // a bogus index, or a message from anyone but the parent does nothing.
      send({ dp: "focus-heading", index: 99, locator: heads[2].locator });
      expect(scrolled.at(-1)!.textContent).toBe("Redis");
      const n = scrolled.length;
      send({ dp: "focus-heading", index: 99, locator: "#redis-p" });
      send({ dp: "focus-heading", index: "1" });
      send({ dp: "focus-heading", index: 0, locator: heads[0].locator }, null);
      expect(scrolled.length).toBe(n);
    });
  });

  it("focus-ask scrolls to the ask and flashes it with our own layer only", () => {
    const asks = of("asks").at(-1).asks;
    send({ dp: "focus-ask", index: 1, locator: asks[1].locator });
    expect(scrolled.at(-1)).toBe(document.getElementById("ask-budget"));
    expect(document.querySelectorAll("dp-annotator-flash")).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(document.querySelectorAll("dp-annotator-flash")).toHaveLength(0);
    const n = scrolled.length;
    send({ dp: "focus-ask", index: 7, locator: "#opt-p" });
    expect(scrolled.length).toBe(n);
  });

  it("reports the current section as the frame scrolls, throttled and only on change", () => {
    const heads = Array.from(document.querySelectorAll("h1, h2, h3")).slice(0, 4);
    let offset = 0;
    const tops = [0, 300, 600, 900];
    heads.forEach((h, i) => {
      (h as any).getBoundingClientRect = () => ({ top: tops[i]! - offset, bottom: tops[i]! - offset + 20, left: 0, right: 100, width: 100, height: 20 });
    });
    Object.defineProperty(window, "innerHeight", { value: 400, configurable: true });
    const scrollTo = (y: number) => { offset = y; window.dispatchEvent(new Event("scroll")); };
    scrollTo(0);
    scrollTo(10);
    vi.advanceTimersByTime(200);
    expect(of("outline-active").at(-1)).toEqual({ dp: "outline-active", index: 0 });
    const before = of("outline-active").length;
    scrollTo(20);
    vi.advanceTimersByTime(200);
    expect(of("outline-active")).toHaveLength(before); // same section: nothing posted
    scrollTo(560);
    vi.advanceTimersByTime(200);
    expect(of("outline-active").at(-1).index).toBe(2);
  });
});

describe("ask id locators: annotator vs shared matcher (#714 gap 5)", () => {
  it("the shared cssEscapeIdent builds the same #id locator the annotator does", async () => {
    const { cssEscapeIdent } = await import("@deeppairing/shared");
    const core = makeCore() as Core & { cssEscape(v: string): string };
    for (const id of ["decide-ttl", "1st", "-2x", "a.b:c", "ünï", "with space", "-", "x\u0001y"]) {
      expect(cssEscapeIdent(id)).toBe(core.cssEscape(id));
    }
  });
});

describe("ask attributes: annotator selector vs shared constants (#714 gap 5)", () => {
  it("the annotator collects exactly the shared PAGE_DECISION_ATTR / PAGE_QUESTION_ATTR", async () => {
    const { PAGE_DECISION_ATTR, PAGE_QUESTION_ATTR } = await import("@deeppairing/shared");
    const core = makeCore() as Core & { ASK_SEL: string };
    expect(core.ASK_SEL).toBe(`[${PAGE_DECISION_ATTR}], [${PAGE_QUESTION_ATTR}]`);
  });
});

// --- #714 gap 10: anchors carry section context ------------------------------

describe("annotator core — section context and element affixes (#714 gap 10)", () => {
  type CtxCore = Core & { sectionFor(el: Element): { heading?: string; id?: string } | null };
  const ctxCore = () => makeCore() as CtxCore;

  it("an element anchor carries prefix, suffix and its section (heading text + the heading's id)", () => {
    const core = ctxCore();
    const second = document.querySelectorAll("section p")[1]!;
    const a = core.anchorForTarget(second)!;
    expect(a).toMatchObject({ kind: "element", quote: "Second bold paragraph." });
    // The page text just outside the element, as the annotator reads it
    // (adjacent blocks with no whitespace between them run together, exactly
    // as for a text anchor's context), up to 32 characters each side.
    expect(a.prefix).toBe("e session cache.First paragraph.");
    expect(String(a.suffix).startsWith("StrategyStaleness")).toBe(true);
    expect(a.prefix.length).toBeLessThanOrEqual(32);
    expect(a.suffix.length).toBeLessThanOrEqual(32);
    expect(a.section).toEqual({ heading: "Cache invalidation", id: "title" });
    expect(HtmlAnchorSchema.safeParse(a).success).toBe(true);
  });

  it("cell, node, link and text anchors carry section context too, and all still parse", () => {
    const core = ctxCore();
    const cell = core.anchorForTarget(document.querySelectorAll("tbody td")[1]!)!;
    expect(cell).toMatchObject({ kind: "cell", table: { row: "TTL expiry", col: "Staleness" }, section: { heading: "Cache invalidation" } });
    expect(cell.prefix).toMatch(/TTL expiry$/);
    expect(cell.suffix).toMatch(/^Write-through purge/);
    const node = core.anchorForTarget(document.querySelector("g.node text")!)!;
    expect(node).toMatchObject({ kind: "diagram-node", nodeId: "AuthGate", section: { heading: "Cache invalidation" } });
    const link = core.anchorForTarget(document.getElementById("rfc")!)!;
    // The link's own id is its nearest ancestor-or-self id.
    expect(link).toMatchObject({ kind: "link", section: { heading: "Cache invalidation", id: "rfc" } });
    const intro = document.querySelector(".intro")!.firstChild!;
    const r = document.createRange();
    r.setStart(intro, 8);
    r.setEnd(intro, 12);
    const text = core.textAnchor(r)!;
    expect(text.section).toEqual({ heading: "Cache invalidation", id: "title" });
    for (const a of [cell, node, link, text]) expect(HtmlAnchorSchema.safeParse(a).success).toBe(true);
  });

  it("names the section by the nearest preceding heading; a page-wide wrapper id yields to the heading's own id", () => {
    document.body.innerHTML =
      '<main id="app"><h2 id="rollout">Rollout</h2><div><p id="p1x">Step one</p><p class="a">Plain</p></div>' +
      '<h2>Risks</h2><p class="b">Step two</p>' +
      '<section id="faq"><h3>FAQ</h3><p>Q?</p></section></main>';
    const core = ctxCore();
    expect(core.sectionFor(document.querySelector(".a")!)).toEqual({ heading: "Rollout", id: "rollout" });
    // No heading id in the Risks section: the nearest ancestor id stands.
    expect(core.sectionFor(document.querySelector(".b")!)).toEqual({ heading: "Risks", id: "app" });
    // A clicked container is named by the first heading inside it and its own id.
    expect(core.sectionFor(document.getElementById("faq")!)).toEqual({ heading: "FAQ", id: "faq" });
    // An element with its own id is the most specific name.
    expect(core.sectionFor(document.getElementById("p1x")!)).toEqual({ heading: "Rollout", id: "p1x" });
  });

  it("caps the heading at 120 characters, skips an over-long id, and returns null with no heading or id", () => {
    const long = "H".repeat(300);
    document.body.innerHTML = `<h4 id="${"x".repeat(201)}">${long}</h4><p class="t">text</p>`;
    const core = ctxCore();
    expect(core.sectionFor(document.querySelector(".t")!)).toEqual({ heading: "H".repeat(120) });
    document.body.innerHTML = '<p class="t">No headings, no ids</p>';
    expect(core.sectionFor(document.querySelector(".t")!)).toBeNull();
    const a = core.anchorForTarget(document.querySelector(".t")!)!;
    expect(a.section).toBeUndefined();
  });

  it("re-finds an id-less element by its saved prefix after the nth-of-type locator drifts", () => {
    document.body.innerHTML = '<h2 id="a">Alpha</h2><p>Same text</p><h2 id="b">Beta</h2><p>Same text</p>';
    const core = ctxCore();
    const target = document.querySelectorAll("p")[1]!;
    const a = core.anchorForTarget(target)!;
    expect(a.locator).toBe("body > p:nth-of-type(2)");
    expect(a.prefix).toBe("AlphaSame textBeta");
    // A new first paragraph shifts nth-of-type: the old locator now hits the
    // FIRST "Same text", but the saved context still names the right one.
    document.body.insertAdjacentHTML("afterbegin", "<p>New intro</p>");
    expect(document.querySelector(a.locator)).not.toBe(target);
    expect(core.findAnchor(a)?.el).toBe(target);
    // Without the new context (an anchor saved before gap 10) the drifted
    // locator wins, exactly as before: existing scoring is unchanged.
    const legacy = { kind: "element", locator: a.locator, quote: a.quote };
    expect(core.findAnchor(legacy)?.el).toBe(document.querySelectorAll("p")[1]);
  });

  it("REVIEW: a tie goes to the locator's element only when its context matches too", () => {
    document.body.innerHTML = '<h2 id="a">X</h2><div>Card</div><h2 id="b">X</h2><div>Card</div>';
    const core = ctxCore();
    const cards = document.querySelectorAll("div");
    // Card A: locator +1, prefix "X" +2 = 3. Card B: prefix "X" +2, section b +1 = 3.
    const hit = core.findAnchor({ kind: "element", locator: "body > div:nth-of-type(1)", quote: "Card", prefix: "X", section: { id: "b" } });
    expect(hit?.el).toBe(cards[0]);
    expect(core.findAnchor({ kind: "element", locator: "body > div:nth-of-type(1)", quote: "Card" })?.el).toBe(cards[0]);
  });

  it("REVIEW: a moved element is not found rather than pinned on the element now at its old locator", () => {
    document.body.innerHTML = '<h2 id="s">S</h2><div>Card</div><h2 id="t">T</h2><p>P</p><div>Card</div>';
    const core = ctxCore();
    // The true element (second card) scores prefix "P" +2. The card now at the
    // old locator scores locator +1 and section s +1 = 2, without matching context.
    expect(core.findAnchor({ kind: "element", locator: "body > div:nth-of-type(1)", quote: "Card", prefix: "P", section: { id: "s" } })).toBeNull();
  });

  it("uses section.id to break a tie between equal text in different sections; without it a tie stays not found", () => {
    document.body.innerHTML = '<h2 id="a">Alpha</h2><p>Same text</p><h2 id="b">Beta</h2><p>Same text</p>';
    const core = ctxCore();
    const base = { kind: "element", locator: "#gone", quote: "Same text" };
    expect(core.findAnchor(base)).toBeNull();
    expect(core.findAnchor({ ...base, section: { id: "b" } })?.el).toBe(document.querySelectorAll("p")[1]);
    expect(core.findAnchor({ ...base, section: { id: "a" } })?.el).toBe(document.querySelectorAll("p")[0]);
  });
});

// --- #714 gap 12: render diagnostics ------------------------------------------

describe("annotator main — render diagnostics (#714 gap 12)", () => {
  let uninstall: () => void;
  let posted: any[];
  beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    vi.spyOn(window, "postMessage").mockImplementation(((msg: unknown) => {
      posted.push(msg);
    }) as typeof window.postMessage);
    uninstall = new Function("document", "window", "parent", "core", ANNOTATOR_MAIN_SOURCE)(document, window, window, makeCore()) as () => void;
  });
  afterEach(() => {
    uninstall();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const diagnostics = () => posted.filter((m) => m?.dp === "diagnostics");
  const scriptError = (message: string) => window.dispatchEvent(new ErrorEvent("error", { message }));
  const cspViolation = (directive: string) => {
    const ev = new Event("securitypolicyviolation", { bubbles: true }) as Event & Record<string, unknown>;
    Object.defineProperty(ev, "effectiveDirective", { value: directive });
    document.dispatchEvent(ev);
  };

  it("posts nothing on a clean page", () => {
    vi.advanceTimersByTime(1000);
    expect(diagnostics()).toEqual([]);
  });

  it("counts script errors, rejections, failed resources (by tag + attribute) and CSP blocks (by directive), redacted", () => {
    scriptError("TypeError: x is undefined at https://user:secret@cdn.example.com/a.js?token=abc");
    scriptError("TypeError: x is undefined at https://user:secret@cdn.example.com/a.js?token=abc");
    scriptError("ReferenceError: y is not defined");
    const rej = new Event("unhandledrejection") as Event & { reason?: unknown };
    rej.reason = new Error("fetch failed for //api.example.com/v1?key=k data:text/plain;base64,QUJD");
    window.dispatchEvent(rej);
    document.body.insertAdjacentHTML("beforeend", '<img id="i1" src="shot.png"><img id="i2" srcset="a.png 1x"><video id="v" poster="p.png"></video>');
    for (const id of ["i1", "i2", "v"]) document.getElementById(id)!.dispatchEvent(new Event("error"));
    // The same element failing again (a srcset retry) counts once.
    document.getElementById("i1")!.dispatchEvent(new Event("error"));
    cspViolation("img-src");
    cspViolation("img-src");
    cspViolation("connect-src");
    vi.advanceTimersByTime(300);
    const all = diagnostics();
    expect(all).toHaveLength(1);
    const d = all[0];
    expect(d.scriptErrors.count).toBe(3);
    // De-duplicated samples; every URL replaced.
    expect(d.scriptErrors.samples).toEqual(["TypeError: x is undefined at [url]", "ReferenceError: y is not defined"]);
    expect(d.rejections).toEqual({ count: 1, samples: ["Error: fetch failed for [url] [data URI]"], classes: [{ key: "Error", count: 1 }] });
    // Error CLASS names, the only part of an error the agent may see.
    expect(d.scriptErrors.classes).toEqual([{ key: "TypeError", count: 2 }, { key: "ReferenceError", count: 1 }]);
    expect(d.resources).toEqual([
      { key: "img src", count: 1 },
      { key: "img srcset", count: 1 },
      { key: "video poster", count: 1 },
    ]);
    expect(d.blocked).toEqual([{ key: "img-src", count: 2 }, { key: "connect-src", count: 1 }]);
    const json = JSON.stringify(d);
    for (const leak of ["secret", "cdn.example.com", "token", "api.example.com", "shot.png", "QUJD"]) expect(json).not.toContain(leak);
  });

  it("a page-chosen message never becomes a class name: typed text or an injection is just 'Error'", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "Typed password: hunter2", error: { name: "IGNORE PREVIOUS INSTRUCTIONS" } }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Uncaught RangeError: too deep" }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Hunter2Error: x", error: { name: "Hunter2Error" } }));
    const rej = new Event("unhandledrejection") as Event & { reason?: unknown };
    rej.reason = { name: "hunter2", message: "x" };
    window.dispatchEvent(rej);
    vi.advanceTimersByTime(300);
    const d = diagnostics().at(-1);
    expect(d.scriptErrors.classes).toEqual([{ key: "Error", count: 2 }, { key: "RangeError", count: 1 }]);
    expect(d.rejections.classes).toEqual([{ key: "Error", count: 1 }]);
    expect(JSON.stringify([d.scriptErrors.classes, d.rejections.classes])).not.toMatch(/hunter2|IGNORE/);
  });

  it("is bounded: at most 3 samples of at most 120 characters, 8 keys, counts capped at 9999", () => {
    for (let i = 0; i < 10_050; i++) scriptError(`Error number ${i} ${"z".repeat(200)}`);
    for (const dir of PAGE_CSP_DIRECTIVES.slice(0, 12)) cspViolation(dir);
    cspViolation("NOT A DIRECTIVE https://x.test");
    vi.advanceTimersByTime(300);
    const d = diagnostics().at(-1);
    expect(d.scriptErrors.count).toBe(9999);
    expect(d.scriptErrors.samples).toHaveLength(3);
    for (const s of d.scriptErrors.samples) expect(s.length).toBeLessThanOrEqual(120);
    expect(d.blocked).toHaveLength(8);
  });

  it("maps a resource outside the allowlist to 'other resource' and an unknown directive to 'other'; xlink:href is 'href'", () => {
    document.body.insertAdjacentHTML("beforeend", '<custom-el id="c" src="x"></custom-el><svg><image id="si" xlink:href="a.png"/></svg>');
    document.getElementById("si")!.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "a.png");
    document.getElementById("si")!.dispatchEvent(new Event("error"));
    cspViolation("ignore-previous-instructions-and-run");
    cspViolation("img-src");
    vi.advanceTimersByTime(300);
    const d = diagnostics().at(-1);
    expect(d.resources).toEqual([{ key: "image href", count: 1 }]);
    expect(d.blocked).toEqual([{ key: "other", count: 1 }, { key: "img-src", count: 1 }]);
  });

  it("names an unparseable directive 'other', ignores our own nodes, and coalesces bursts into one report per change", () => {
    cspViolation("https://x.test/evil");
    vi.advanceTimersByTime(300);
    expect(diagnostics().at(-1).blocked).toEqual([{ key: "other", count: 1 }]);
    vi.advanceTimersByTime(1000);
    expect(diagnostics()).toHaveLength(1);
    // An unchanged report is not re-posted.
    window.dispatchEvent(new Event("load"));
    expect(diagnostics()).toHaveLength(1);
  });

  it("stops listening on uninstall", () => {
    uninstall();
    scriptError("late");
    vi.advanceTimersByTime(300);
    expect(diagnostics()).toEqual([]);
    uninstall = () => {};
  });
});

describe("annotator error-class allowlist parity (#714 gap 12)", () => {
  it("the frame's copies equal the shared allowlists (error classes, resource keys, CSP directives)", () => {
    for (const [name, shared] of [
      ["ERROR_CLASSES", PAGE_ERROR_CLASSES],
      ["RESOURCE_KEYS", PAGE_RESOURCE_KEYS],
      ["CSP_DIRECTIVES", PAGE_CSP_DIRECTIVES],
    ] as const) {
      const m = new RegExp(`var ${name} = (\\[[^\\]]*\\]);`).exec(ANNOTATOR_MAIN_SOURCE);
      expect(m, name).not.toBeNull();
      expect(JSON.parse(m![1]!), name).toEqual([...shared]);
    }
  });
});


describe("annotator core — commentable blocks (#714 gap 9)", () => {
  type BlockCore = Core & { commentableBlocks(): Element[]; blockKind(el: Element): string };
  const blockCore = () => makeCore() as BlockCore;

  it("lists text blocks, cells, Mermaid nodes and links in document order, skipping wrappers that repeat a child", () => {
    document.body.innerHTML =
      "<h2>Plan</h2><ul><li><p>Same text</p></li><li>Two</li></ul>" +
      "<table><tr><th>A</th></tr><tr><td>1</td></tr></table>" +
      "<svg><g class=\"node\" id=\"flowchart-X-1\"><text>X</text></g></svg>" +
      "<p>See <a href=\"#plan\">the plan</a></p>" +
      "<details><summary>More</summary><p>Hidden inside</p></details>" +
      "<p hidden>Gone</p><script>var x = 1;</script>";
    const core = blockCore();
    const list = core.commentableBlocks();
    const names = list.map((el) => `${el.localName}:${el.textContent!.trim()}`);
    expect(names).toEqual(["h2:Plan", "p:Same text", "li:Two", "th:A", "td:1", "g:X", "p:See the plan", "a:the plan", "summary:More"]);
    expect(list.map((el) => core.blockKind(el))).toEqual([
      "heading", "paragraph", "list item", "cell", "cell", "diagram node", "paragraph", "link", "control",
    ]);
  });

  it("names asks by kind and never lists our own layer", () => {
    document.body.innerHTML = "<div data-dp-decision><p>Pick one</p></div><dp-annotator-layer><p>ours</p></dp-annotator-layer>";
    const core = blockCore();
    const list = core.commentableBlocks();
    expect(list.map((el) => core.blockKind(el))).toEqual(["decision", "paragraph"]);
  });
});

describe("annotator main — keyboard comment mode and touch (#714 gap 9)", () => {
  let uninstall: () => void;
  let posted: any[];
  let realScroll: typeof Element.prototype.scrollIntoView;
  beforeEach(() => {
    posted = [];
    realScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {};
    vi.spyOn(window, "postMessage").mockImplementation(((msg: unknown) => {
      posted.push(msg);
    }) as typeof window.postMessage);
    uninstall = new Function("document", "window", "parent", "core", ANNOTATOR_MAIN_SOURCE)(
      document, window, window, makeCore(),
    ) as () => void;
  });
  afterEach(() => {
    uninstall();
    Element.prototype.scrollIntoView = realScroll;
    vi.restoreAllMocks();
  });
  const mode = (extra: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent("message", { data: { dp: "mode", annotate: true, scripts: false, ...extra }, source: window }));
  const key = (k: string, init: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(ev);
    return ev;
  };
  const cursors = () => posted.filter((m) => m?.dp === "kbd-cursor");

  it("turning the mode on reports the first block; arrows and Tab move; Enter posts that block's anchor", () => {
    mode({ kbd: true });
    expect(cursors().at(-1)).toMatchObject({ index: 0, kind: "heading", text: "Cache invalidation", pins: [] });
    expect(document.querySelector("dp-annotator-kbd")).not.toBeNull();
    const ev = key("ArrowDown");
    expect(ev.defaultPrevented).toBe(true);
    expect(cursors().at(-1)).toMatchObject({ index: 1, kind: "paragraph" });
    key("Tab");
    key("ArrowUp");
    expect(cursors().at(-1)).toMatchObject({ index: 1 });
    key("End");
    const last = cursors().at(-1);
    expect(last.index).toBe(last.total - 1);
    key("Home");
    key("Enter");
    const anchors = posted.filter((m) => m?.dp === "anchor").map((m) => m.anchor);
    expect(anchors).toEqual([expect.objectContaining({ kind: "element", locator: "#title", quote: "Cache invalidation" })]);
    expect(HtmlAnchorSchema.safeParse(anchors[0]).success).toBe(true);
  });

  it("stops handled keys before the page's own listeners see them", () => {
    const seen: string[] = [];
    const pageListener = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener("keydown", pageListener);
    mode({ kbd: true });
    key("ArrowDown");
    key("Enter");
    document.removeEventListener("keydown", pageListener);
    expect(seen).toEqual([]);
  });

  it("Escape leaves the mode and tells the parent; Tab past the last block leaves without trapping focus", () => {
    mode({ kbd: true });
    key("Escape");
    expect(posted.filter((m) => m?.dp === "kbd-off")).toHaveLength(1);
    expect(document.querySelector("dp-annotator-kbd")).toBeNull();
    mode({ kbd: true });
    key("End");
    const tab = key("Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(posted.filter((m) => m?.dp === "kbd-off")).toHaveLength(2);
  });

  it("says which pins sit on the block under the cursor", () => {
    window.dispatchEvent(new MessageEvent("message", {
      data: { dp: "pins", anchors: [{ kind: "element", locator: "#title", quote: "Cache invalidation" }], states: ["open"], ids: ["c1"] },
      source: window,
    }));
    mode({ kbd: true });
    expect(cursors().at(-1)).toMatchObject({ index: 0, pins: [0] });
  });

  it("the mode needs pointing, and never takes keys typed into a page field", () => {
    mode({ kbd: true, annotate: false });
    expect(key("ArrowDown").defaultPrevented).toBe(false);
    mode({ kbd: true });
    document.body.insertAdjacentHTML("beforeend", "<input id=\"f\">");
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    document.getElementById("f")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("forwards C, ?, ], [ and Escape to the parent before Run only", () => {
    for (const k of ["c", "?", "]", "[", "Escape"]) key(k);
    expect(posted.filter((m) => m?.dp === "key").map((m) => m.key)).toEqual(["toggle-kbd", "help", "next", "prev", "escape"]);
    mode({ scripts: true });
    posted.length = 0;
    const ev = key("c");
    expect(ev.defaultPrevented).toBe(false);
    expect(posted.filter((m) => m?.dp === "key")).toEqual([]);
  });

  it("marks every node it draws aria-hidden (pins are announced by the companion)", () => {
    window.dispatchEvent(new MessageEvent("message", {
      data: { dp: "pins", anchors: [{ kind: "element", locator: "#title", quote: "Cache invalidation" }] },
      source: window,
    }));
    mode({ kbd: true });
    const drawn = Array.from(document.querySelectorAll("dp-annotator-pin, dp-annotator-badge, dp-annotator-kbd"));
    expect(drawn.length).toBe(3);
    expect(drawn.every((el) => el.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("after a touch, the compatibility mousemove paints no hover outline", () => {
    const p = document.querySelector(".intro")!;
    const down = new Event("pointerdown", { bubbles: true, cancelable: true }) as Event & { pointerType?: string };
    Object.defineProperty(down, "pointerType", { value: "touch" });
    p.dispatchEvent(down);
    p.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    const hover = document.querySelector("dp-annotator-hover") as HTMLElement | null;
    expect(!hover || hover.style.getPropertyValue("display") === "none").toBe(true);
  });

  it("a touch selection gets a Comment button that posts the text anchor", async () => {
    vi.useFakeTimers();
    try {
      const p = document.querySelector(".intro")!;
      const down = new Event("pointerdown", { bubbles: true, cancelable: true });
      Object.defineProperty(down, "pointerType", { value: "touch" });
      p.dispatchEvent(down);
      const range = document.createRange();
      range.setStart(p.firstChild!, 8);
      range.setEnd(p.firstChild!, 16);
      // jsdom has no layout: give the range a box.
      (range as any).getBoundingClientRect = () => ({ left: 10, top: 10, right: 60, bottom: 24, width: 50, height: 14 });
      vi.spyOn(window, "getSelection").mockReturnValue({
        isCollapsed: false, rangeCount: 1, getRangeAt: () => range, removeAllRanges() {},
      } as unknown as Selection);
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersByTime(400);
      const btn = document.querySelector("dp-annotator-selbtn") as HTMLElement;
      expect(btn).not.toBeNull();
      expect(btn.getAttribute("aria-label")).toBe("Comment on the selected text");
      expect(btn.getAttribute("aria-hidden")).toBeNull();
      expect(btn.style.getPropertyValue("min-height")).toBe("44px");
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const anchors = posted.filter((m) => m?.dp === "anchor").map((m) => m.anchor);
      expect(anchors).toEqual([expect.objectContaining({ kind: "text", quote: "pick one" })]);
      expect(document.querySelector("dp-annotator-selbtn")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("on a coarse pointer, a pin badge keeps its look but takes a 44px hit area", () => {
    const down = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(down, "pointerType", { value: "touch" });
    document.body.dispatchEvent(down);
    window.dispatchEvent(new MessageEvent("message", {
      data: { dp: "pins", anchors: [{ kind: "element", locator: "#title", quote: "Cache invalidation" }], ids: ["c1"] },
      source: window,
    }));
    const badge = document.querySelector("dp-annotator-badge") as HTMLElement;
    expect(badge.style.getPropertyValue("border")).toMatch(/^13px solid/);
    expect(badge.style.getPropertyValue("left")).toBe("-46px");
  });

  it("#725 — stops the keyup and keypress of a handled key too", () => {
    const seen: string[] = [];
    const page = (e: Event) => { seen.push(`${e.type}:${(e as KeyboardEvent).key}`); };
    for (const t of ["keyup", "keypress"]) document.addEventListener(t, page);
    mode({ kbd: true });
    key("ArrowDown");
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true, cancelable: true }));
    key("Enter");
    document.body.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
    // An unhandled key's keyup still reaches the page.
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true, cancelable: true }));
    for (const t of ["keyup", "keypress"]) document.removeEventListener(t, page);
    expect(seen).toEqual(["keyup:x"]);
  });

  it("#725 — C with Caps Lock forwards toggle-kbd too", () => {
    key("C");
    expect(posted.filter((m) => m?.dp === "key").map((m) => m.key)).toEqual(["toggle-kbd"]);
  });

  it("#725 — the touch Comment button sits outside every aria-hidden node", () => {
    vi.useFakeTimers();
    try {
      const p = document.querySelector(".intro")!;
      const down = new Event("pointerdown", { bubbles: true, cancelable: true });
      Object.defineProperty(down, "pointerType", { value: "touch" });
      p.dispatchEvent(down);
      const range = document.createRange();
      range.setStart(p.firstChild!, 8);
      range.setEnd(p.firstChild!, 16);
      (range as any).getBoundingClientRect = () => ({ left: 10, top: 10, right: 60, bottom: 24, width: 50, height: 14 });
      vi.spyOn(window, "getSelection").mockReturnValue({
        isCollapsed: false, rangeCount: 1, getRangeAt: () => range, removeAllRanges() {},
      } as unknown as Selection);
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersByTime(400);
      const btn = document.querySelector("dp-annotator-selbtn") as HTMLElement;
      expect(btn).not.toBeNull();
      expect(btn.closest('[aria-hidden="true"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("#725 P3-1 — a handled key whose keyup never arrives doesn't eat that key later in a page field", () => {
    mode({ kbd: true });
    // Enter opens the composer in the companion: its keyup lands there, not here.
    key("Enter", { code: "Enter" });
    mode({ kbd: false });
    document.body.insertAdjacentHTML("beforeend", "<textarea id=\"ta\"></textarea>");
    const ta = document.getElementById("ta")!;
    const kp = new KeyboardEvent("keypress", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    ta.dispatchEvent(kp);
    expect(kp.defaultPrevented).toBe(false);
    const ku = new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    ta.dispatchEvent(ku);
    expect(ku.defaultPrevented).toBe(false);
  });

  it("#725 P3-1 — a stuck entry clears on blur and on another key's keydown", () => {
    mode({ kbd: true });
    key("ArrowDown", { code: "ArrowDown" });
    window.dispatchEvent(new Event("blur"));
    const up1 = new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true });
    document.body.dispatchEvent(up1);
    expect(up1.defaultPrevented).toBe(false);
    // ? then Shift released first: the keyup reads "/" but has the same code.
    mode({ kbd: false });
    key("?", { code: "Slash", shiftKey: true });
    const slashUp = new KeyboardEvent("keyup", { key: "/", code: "Slash", bubbles: true, cancelable: true });
    document.body.dispatchEvent(slashUp);
    expect(slashUp.defaultPrevented).toBe(true);
    key("]", { code: "BracketRight" });
    key("x", { code: "KeyX" });
    const up2 = new KeyboardEvent("keyup", { key: "]", code: "BracketRight", bubbles: true, cancelable: true });
    document.body.dispatchEvent(up2);
    expect(up2.defaultPrevented).toBe(false);
  });
});
