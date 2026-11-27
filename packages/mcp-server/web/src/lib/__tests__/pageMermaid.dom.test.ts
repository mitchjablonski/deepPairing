/**
 * #714 gap 11 — Mermaid blocks rendered parent-side, then sanitized and put in
 * place of the block. happy-dom has no layout (Mermaid needs getBBox), so the
 * renderer is a FAKE that returns Mermaid-shaped (and hostile) SVG; real
 * rendering is covered by the standalone-session e2e.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ANNOTATOR_CORE_SOURCE } from "../pageAnnotator";
import { sanitizePageHtml } from "../pageSanitize";
import {
  sanitizeSvgTree, PAGE_MERMAID_NOTES, PAGE_MERMAID_PREPARE, cleanSvgCss, clearPageMermaidCache, findMermaidBlocks, pageMermaidId,
  preparePageMermaid, renderPageMermaid, sanitizeMermaidSvg, type MermaidRenderer,
} from "../pageMermaid";

// NOTE: happy-dom's HTML parser drops everything after a <style> inside an
// <svg> (real browsers don't), so the fakes put no <style> in their SVG; the
// <style> branch is tested on a DOM-built tree via sanitizeSvgTree.

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A fake shaped like REAL Mermaid 11 flowchart output with htmlLabels off
 *  (what the isolated renderer produces): `g.node` with an id of
 *  `<svgId>-flowchart-<nodeId>-<n>` and NO data-id (Mermaid 11 sets data-id on
 *  edges only), labels as escaped SVG text/tspans, edges with data-id and a
 *  marker-end url(#…). */
function fakeFlowchart(calls: Array<{ id: string; source: string; theme: string }> = []): MermaidRenderer {
  return async (id, source, theme) => {
    calls.push({ id, source, theme });
    const nodes = [...source.matchAll(/(\w+)\[([^\]]*)\]/g)].map(
      ([, nid, label], k) =>
        `<g class="node default" id="${id}-flowchart-${nid}-${k}" transform="translate(10,10)">` +
        `<rect class="basic label-container" style="" x="-40" y="-12" width="80" height="24" fill="url(#grad)"></rect>` +
        `<g class="label" style="" transform="translate(0,0)"><rect></rect><g><rect class="background" style="stroke: none"></rect>` +
        `<text y="-10.1" style=""><tspan class="text-outer-tspan" x="0" y="-0.1em" dy="1.1em">` +
        `<tspan font-style="normal" class="text-inner-tspan" font-weight="normal">${esc(label!)}</tspan></tspan></text></g></g></g>`,
    );
    const edges = [...source.matchAll(/(\w+)(?:\[[^\]]*\])?\s*-->\s*(\w+)/g)].map(
      ([, a, b], k) =>
        `<path d="M0,0L10,10" id="${id}-L_${a}_${b}_${k}" class="flowchart-link" data-edge="true" data-et="edge" ` +
        `data-id="L_${a}_${b}_${k}" marker-end="url(#${id}_flowchart-v2-pointEnd)"></path>`,
    );
    return `<svg id="${id}" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" style="max-width: 200px;" ` +
      `viewBox="0 0 200 60" role="graphics-document document" aria-roledescription="flowchart-v2">` +
      `<g><marker id="${id}_flowchart-v2-pointEnd" class="marker flowchart-v2" viewBox="0 0 10 10" refX="5" refY="5" orient="auto">` +
      `<path d="M 0 0 L 10 5 L 0 10 z" class="arrowMarkerPath" style="stroke-width: 1; stroke-dasharray: 1, 0;"></path></marker>` +
      `<defs><linearGradient id="grad"><stop offset="0"></stop></linearGradient></defs>` +
      `<g class="root"><g class="edgePaths">${edges.join("")}</g><g class="nodes">${nodes.join("")}</g></g></g></svg>`;
  };
}

/** The worst case: a renderer that emits htmlLabels foreignObject HTML with
 *  the label embedded RAW (what a buggy or misconfigured Mermaid could do). */
function fakeHtmlLabels(): MermaidRenderer {
  return async (id, source) => {
    const nodes = [...source.matchAll(/(\w+)\[([^\]]*)\]/g)].map(
      ([, nid, label], k) =>
        `<g class="node default" id="${id}-flowchart-${nid}-${k}"><rect fill="url(#grad)"></rect>` +
        `<foreignObject width="80" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; white-space: nowrap;">` +
        `<span class="nodeLabel"><p>${label}</p></span></div></foreignObject></g>`,
    );
    return `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><g class="nodes">${nodes.join("")}</g></svg>`;
  };
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Every attribute name/value and tag in a document, for "nothing hostile
 *  survived" assertions that don't depend on serialization quirks. */
function audit(doc: Document) {
  const tags: string[] = [];
  const attrs: Array<[string, string]> = [];
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    tags.push(el.localName.toLowerCase());
    for (const a of Array.from(el.attributes)) attrs.push([a.name.toLowerCase(), a.value]);
  }
  return { tags, attrs };
}

function expectNothingHostile(html: string) {
  const { tags, attrs } = audit(parse(html));
  expect(tags).not.toContain("script");
  expect(tags).not.toContain("iframe");
  expect(tags).not.toContain("img");
  expect(tags).not.toContain("image");
  expect(tags).not.toContain("animate");
  expect(tags).not.toContain("set");
  expect(tags).not.toContain("a");
  for (const [name, value] of attrs) {
    expect(name.startsWith("on"), `${name}=${value}`).toBe(false);
    expect(value, name).not.toMatch(/javascript:|vbscript:|https?:\/\/(?!www\.w3\.org)|\/\/evil/i);
  }
  for (const style of Array.from(parse(html).querySelectorAll("style"))) {
    expect(style.textContent).not.toMatch(/@import|url\(\s*['"]?\s*[^#\s'"]/i);
  }
}

beforeEach(() => clearPageMermaidCache());

describe("renderPageMermaid", () => {
  it("renders pre.mermaid, div.mermaid and code.language-mermaid to sanitized SVG in place", async () => {
    const calls: Array<{ id: string; source: string; theme: string }> = [];
    const html =
      "<html lang=\"en\"><body class=\"pg\"><h1>Flow</h1>" +
      "<pre class=\"mermaid\" id=\"flow\">flowchart LR\n  A[Start] --&gt; B[Done]</pre>" +
      "<div class=\"mermaid\">flowchart TD\n  C[Cache]</div>" +
      "<pre><code class=\"language-mermaid\">flowchart TD\n  D[Disk]</code></pre>" +
      "<p>After</p></body></html>";
    const out = await renderPageMermaid(html, { theme: "light", renderer: fakeFlowchart(calls) });
    expect(out).toMatchObject({ rendered: 3, fallback: 0 });
    // The decoded source went to the renderer, with deterministic ids.
    expect(calls.map((c) => c.id)).toEqual([pageMermaidId(0), pageMermaidId(1), pageMermaidId(2)]);
    expect(calls[0]!.source).toBe("flowchart LR\n  A[Start] --> B[Done]");
    expect(calls[0]!.theme).toBe("light");
    const doc = parse(out.html);
    expect(doc.querySelectorAll("pre, .mermaid, code")).toHaveLength(0);
    const renders = doc.querySelectorAll("[data-dp-mermaid=rendered] > svg");
    expect(renders).toHaveLength(3);
    // The block's id moves onto the rendered wrapper; page root attrs survive.
    expect(doc.getElementById("flow")?.querySelector("svg")).not.toBeNull();
    expect(doc.documentElement.getAttribute("lang")).toBe("en");
    expect(doc.body.getAttribute("class")).toBe("pg");
    expect(doc.body.textContent).toContain("After");
    // Local url(#…) refs and the diagram's own style survive.
    expect(doc.querySelector("rect")?.getAttribute("fill")).toBe("url(#grad)");
    // Real-shaped output survives intact: text labels, marker refs, edge data-id.
    expect(doc.querySelector(`g.node[id='${pageMermaidId(0)}-flowchart-A-0'] tspan.text-inner-tspan`)?.textContent).toBe("Start");
    expect(doc.querySelector("path.flowchart-link")?.getAttribute("marker-end")).toBe(`url(#${pageMermaidId(0)}_flowchart-v2-pointEnd)`);
    expect(doc.querySelector("path.flowchart-link")?.getAttribute("data-id")).toBe("L_A_B_0");
  });

  it("leaves a page without blocks byte-identical and never calls the renderer", async () => {
    const renderer = vi.fn<MermaidRenderer>();
    const html = "<h1>No diagrams</h1><p>We considered mermaid but used SVG.</p>";
    expect(await renderPageMermaid(html, { theme: "dark", renderer })).toEqual({ html, rendered: 0, fallback: 0, timedOut: 0 });
    expect(await renderPageMermaid("<h1>x</h1>", { theme: "dark", renderer })).toEqual({ html: "<h1>x</h1>", rendered: 0, fallback: 0, timedOut: 0 });
    expect(renderer).not.toHaveBeenCalled();
    expect(PAGE_MERMAID_PREPARE.needed("<h1>x</h1>")).toBe(false);
    expect(PAGE_MERMAID_PREPARE.needed("<pre class=mermaid>x</pre>")).toBe(true);
    // A page that only MENTIONS Mermaid has no blocks: no placeholder, no render.
    expect(PAGE_MERMAID_PREPARE.needed(html)).toBe(false);
    expect(PAGE_MERMAID_PREPARE.needed("<p class=\"mermaid-note\">Mermaid</p><pre class=mermaid>  </pre>")).toBe(false);
  });

  it("keeps Mermaid's node ids (no data-id on real nodes), so the annotator's diagram-node anchor resolves", async () => {
    const html = "<h1>Flow</h1><pre class=\"mermaid\">flowchart LR\n  AuthGate[Auth gate] --&gt; Store[Store]</pre>";
    const out = await renderPageMermaid(html, { theme: "light", renderer: fakeFlowchart() });
    // Through the before-Run sanitizer too, as the frame does.
    const framed = sanitizePageHtml(out.html).html;
    document.body.innerHTML = framed;
    const node = document.querySelector(`g.node[id$='-flowchart-AuthGate-0']`);
    expect(node).not.toBeNull();
    expect(node!.id).toBe(`${pageMermaidId(0)}-flowchart-AuthGate-0`);
    expect(node!.hasAttribute("data-id")).toBe(false);
    const core = new Function("document", "window", ANNOTATOR_CORE_SOURCE)(document, window) as {
      anchorForTarget(t: Node): Record<string, unknown> | null;
      findAnchor(a: unknown): { el: Element } | null;
    };
    const label = node!.querySelector("tspan.text-inner-tspan")!;
    const anchor = core.anchorForTarget(label.firstChild!)!;
    expect(anchor).toMatchObject({ kind: "diagram-node", nodeId: "AuthGate" });
    expect(core.findAnchor(anchor)?.el).toBe(node);
    document.body.innerHTML = "";
  });

  it("hostile Mermaid input (script labels, javascript: links, click directives) yields no script, handlers or external refs", async () => {
    const src =
      "flowchart LR\n" +
      "  B[<img src=x onerror=alert(2)>]\n" +
      "  C[<a href=\"javascript:alert(3)\">go</a>] --> D[<iframe src=\"https://evil.test\"></iframe>]\n" +
      "  E[<span onmouseover=alert(4) style=\"background:url(https://evil.test/x.png)\">hover</span>]\n" +
      // Last: happy-dom's parser swallows everything after a <script> in SVG.
      "  A[<script>alert(1)</script>] --> B\n" +
      "  click A \"javascript:alert(5)\"\n  click B callback";
    const html = `<h1>t</h1><pre class="mermaid">${src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
    // Real-shaped (escaped text labels) and the worst case (raw label HTML).
    const real = await renderPageMermaid(html, { theme: "dark", renderer: fakeFlowchart() });
    expect(real.rendered).toBe(1);
    expectNothingHostile(real.html);
    const out = await renderPageMermaid(html, { theme: "dark", renderer: fakeHtmlLabels() });
    expect(out.rendered).toBe(1);
    expectNothingHostile(out.html);
    // The label text that is safe survives (the link is unwrapped, not lost).
    const doc = parse(out.html);
    expect(doc.querySelector("g.node[id*='-flowchart-C-']")?.textContent).toContain("go");
    expect(doc.querySelector("g.node[id*='-flowchart-E-'] span")?.hasAttribute("style")).toBe(false);
  });

  it("a hostile SVG from the renderer itself is reduced to the allowlist", async () => {
    const hostile =
      `<svg id="x" onload="alert(1)" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
      `<g class="node" data-id="A" id="x-flowchart-A-0" onclick="alert(4)" style="fill:url(https://evil.test/f)">` +
      `<a href="javascript:alert(5)"><text>A</text></a><a xlink:href="https://evil.test"><text>B</text></a></g>` +
      `<image href="https://evil.test/i.png"/><use href="https://evil.test/s.svg#a"/><use href="#ok"/>` +
      `<animate attributeName="href" to="javascript:alert(6)"/><set attributeName="onclick" to="alert(7)"/>` +
      `<rect filter="url(https://evil.test/f#x)" mask="url( '#m' )"/>` +
      `<foreignObject><div onmouseover="alert(8)"><img src="https://evil.test/a.png">` +
      `<iframe srcdoc="<script>alert(10)</script>"></iframe>` +
      `<custom-el data-x="1"><b>kept</b></custom-el><span style="background:u\\72l(https://evil.test)">L</span>` +
      // Scripts last: happy-dom's parser swallows everything after a <script>
      // inside SVG (browsers don't); the DOM-built test below covers removal
      // with siblings after it.
      `<svg><script>alert(11)</script></svg><script>alert(9)</script></div></foreignObject>` +
      `<script>alert(2)</script><SCRIPT>alert(3)</SCRIPT></svg>`;
    const out = await renderPageMermaid("<pre class=mermaid>flowchart LR\n A</pre>", { theme: "light", renderer: async () => hostile });
    expect(out.rendered).toBe(1);
    expectNothingHostile(out.html);
    expect(out.html).not.toContain("alert(");
    const doc = parse(out.html);
    expect(doc.querySelector("use[href='#ok']")).not.toBeNull();
    expect(doc.querySelector("rect")?.getAttribute("mask")).toBe("url( '#m' )");
    expect(doc.querySelector("rect")?.hasAttribute("filter")).toBe(false);
    expect(doc.querySelector("g.node")?.hasAttribute("style")).toBe(false);
    expect(doc.querySelector("foreignObject b")?.textContent).toBe("kept");
    expect(doc.querySelector("custom-el")).toBeNull();
    expect(doc.querySelector("g.node text")?.textContent).toBe("A");
  });

  it("a render failure keeps the source with an inline note", async () => {
    const html = "<h1>t</h1><pre class=\"mermaid\">flowchart LR\n  A[ok]</pre><pre class=\"mermaid\">not a diagram</pre>";
    const renderer: MermaidRenderer = async (id, source) => {
      if (source === "not a diagram") throw new Error("Parse error on line 1");
      return fakeFlowchart()(id, source, "light");
    };
    const out = await renderPageMermaid(html, { theme: "light", renderer });
    expect(out).toMatchObject({ rendered: 1, fallback: 1 });
    const doc = parse(out.html);
    const pre = doc.querySelector("pre.mermaid")!;
    expect(pre.textContent).toBe("not a diagram");
    const note = pre.nextElementSibling!;
    expect(note.hasAttribute("data-dp-mermaid-note")).toBe(true);
    expect(note.textContent).toBe(PAGE_MERMAID_NOTES.failed);
    expect(note.textContent).toMatch(/diagram couldn't be rendered/i);
  });

  it("an SVG that isn't a single <svg> root, or is over the size cap, falls back too", async () => {
    const html = "<pre class=\"mermaid\">a</pre><pre class=\"mermaid\">b</pre>";
    const renderer: MermaidRenderer = async (_id, source) => (source === "a" ? "<div>not svg</div>" : `<svg>${"x".repeat(200)}</svg>`);
    const out = await renderPageMermaid(html, { theme: "light", renderer, maxSvgChars: 100 });
    expect(out).toMatchObject({ rendered: 0, fallback: 2 });
    const notes = Array.from(parse(out.html).querySelectorAll("[data-dp-mermaid-note]")).map((n) => n.textContent);
    expect(notes).toEqual([PAGE_MERMAID_NOTES.failed, PAGE_MERMAID_NOTES.tooLarge]);
  });

  it("caps the number of diagrams and the source size", async () => {
    const calls: Array<{ id: string; source: string; theme: string }> = [];
    const blocks = Array.from({ length: 4 }, (_, i) => `<pre class="mermaid">flowchart LR\n  N${i}[n]</pre>`).join("");
    const big = `<pre class="mermaid">flowchart LR\n  ${"A[x]-->".repeat(50)}B[y]</pre>`;
    const out = await renderPageMermaid(big + blocks, { theme: "light", renderer: fakeFlowchart(calls), maxDiagrams: 3, maxSourceChars: 200 });
    // Block 0 is too large; blocks 1-2 render; blocks 3-4 are over the count.
    expect(out).toMatchObject({ rendered: 2, fallback: 3 });
    expect(calls).toHaveLength(2);
    const notes = Array.from(parse(out.html).querySelectorAll("[data-dp-mermaid-note]")).map((n) => n.textContent);
    expect(notes).toEqual([PAGE_MERMAID_NOTES.tooLarge, PAGE_MERMAID_NOTES.tooMany, PAGE_MERMAID_NOTES.tooMany]);
  });

  it("times out a hung diagram, and stops rendering once the page budget is spent", async () => {
    vi.useFakeTimers();
    try {
      const html = Array.from({ length: 3 }, (_, i) => `<pre class="mermaid">flowchart LR\n  N${i}[n]</pre>`).join("");
      let started = 0;
      const signals: AbortSignal[] = [];
      const hang: MermaidRenderer = (_id, _src, _theme, signal) => { started++; signals.push(signal!); return new Promise<string>(() => {}); };
      const p = renderPageMermaid(html, { theme: "light", renderer: hang, timeoutMs: 1_000, totalTimeoutMs: 1_500 });
      await vi.advanceTimersByTimeAsync(1_000); // diagram 0 times out
      await vi.advanceTimersByTimeAsync(500); // diagram 1 hits the page budget
      const out = await p;
      expect(out).toMatchObject({ rendered: 0, fallback: 3, timedOut: 3 });
      // Diagram 2 is never even started: the budget was spent.
      expect(started).toBe(2);
      // Each timed-out request was ABORTED (so the frame renderer kills it).
      expect(signals.map((sg) => sg.aborted)).toEqual([true, true]);
      const notes = Array.from(parse(out.html).querySelectorAll("[data-dp-mermaid-note]")).map((n) => n.textContent);
      expect(notes).toEqual([PAGE_MERMAID_NOTES.timedOut, PAGE_MERMAID_NOTES.timedOut, PAGE_MERMAID_NOTES.timedOut]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows the companion theme: the renderer gets it and a dark diagram gets its own dark panel", async () => {
    const calls: Array<{ id: string; source: string; theme: string }> = [];
    const html = "<pre class=\"mermaid\">flowchart LR\n  A[a]</pre>";
    const dark = parse((await renderPageMermaid(html, { theme: "dark", renderer: fakeFlowchart(calls) })).html);
    const light = parse((await renderPageMermaid(html, { theme: "light", renderer: fakeFlowchart(calls) })).html);
    expect(calls.map((c) => c.theme)).toEqual(["dark", "light"]);
    expect(dark.querySelector("[data-dp-mermaid]")?.getAttribute("style")).toMatch(/background:#1f2020/);
    expect(light.querySelector("[data-dp-mermaid]")?.getAttribute("style")).not.toMatch(/background/);
  });
});

describe("preparePageMermaid (cache)", () => {
  it("renders once per (content, theme) and re-renders for a new version or theme", async () => {
    const calls: Array<{ id: string; source: string; theme: string }> = [];
    const r = fakeFlowchart(calls);
    const v1 = "<pre class=\"mermaid\">flowchart LR\n  A[a]</pre>";
    const v2 = "<pre class=\"mermaid\">flowchart LR\n  A[b]</pre>";
    const a = await preparePageMermaid(v1, "light", r);
    expect(await preparePageMermaid(v1, "light", r)).toBe(a);
    expect(calls).toHaveLength(1);
    await preparePageMermaid(v2, "light", r);
    await preparePageMermaid(v1, "dark", r);
    expect(calls).toHaveLength(3);
    expect(a).toContain("<svg");
  });

  it("never caches a timeout: the next mount retries", async () => {
    vi.useFakeTimers();
    try {
      const html = "<pre class=\"mermaid\">flowchart LR\n  A[a]</pre>";
      let calls = 0;
      let hang = true;
      const renderer: MermaidRenderer = (id, src, theme) => {
        calls++;
        return hang ? new Promise<string>(() => {}) : fakeFlowchart()(id, src, theme);
      };
      const first = preparePageMermaid(html, "light", renderer);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await first).toContain(PAGE_MERMAID_NOTES.timedOut);
      hang = false;
      const second = await preparePageMermaid(html, "light", renderer);
      expect(calls).toBe(2);
      expect(second).toContain("flowchart-A-0");
      expect(second).not.toContain(PAGE_MERMAID_NOTES.timedOut);
      // A genuine result IS cached.
      await preparePageMermaid(html, "light", renderer);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never rejects: a throwing pipeline resolves to the input", async () => {
    const html = "<pre class=\"mermaid\">x</pre>";
    const out = await preparePageMermaid(html, "light", () => { throw new Error("boom"); });
    expect(out).toContain("x</pre>");
    expect(out).toContain(PAGE_MERMAID_NOTES.failed);
  });
});

describe("sanitizeMermaidSvg / cleanSvgCss / findMermaidBlocks", () => {
  it("keeps <switch> (journey task labels) and still sanitizes its children", () => {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    const sw = document.createElementNS(NS, "switch");
    const text = document.createElementNS(NS, "text");
    text.setAttribute("onclick", "alert(1)");
    text.textContent = "Task";
    const fo = document.createElementNS(NS, "foreignObject");
    const s1 = document.createElement("script");
    s1.textContent = "alert(2)";
    const d = document.createElement("div");
    d.textContent = "Label";
    fo.append(s1, d);
    sw.append(fo, text);
    svg.append(sw);
    sanitizeSvgTree(svg);
    expect(svg.querySelector("switch > text")?.textContent).toBe("Task");
    expect(svg.querySelector("switch > text")?.hasAttribute("onclick")).toBe(false);
    expect(svg.querySelector("switch foreignObject div")?.textContent).toBe("Label");
    expect(svg.querySelector("script")).toBeNull();
  });

  it("returns null for a non-svg root", () => {
    expect(sanitizeMermaidSvg("<p>x</p>")).toBeNull();
    expect(sanitizeMermaidSvg("")).toBeNull();
  });

  it("SVG and foreignObject <script>s are removed and their siblings kept (DOM-built tree)", () => {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    const s1 = document.createElementNS(NS, "script");
    s1.textContent = "alert(1)";
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "node");
    g.setAttribute("data-id", "A");
    const fo = document.createElementNS(NS, "foreignObject");
    const div = document.createElement("div");
    const s2 = document.createElement("script");
    s2.textContent = "alert(2)";
    const p = document.createElement("p");
    p.textContent = "label";
    div.append(s2, p);
    fo.append(div);
    g.append(fo);
    svg.append(s1, g);
    sanitizeSvgTree(svg);
    expect(svg.querySelectorAll("script")).toHaveLength(0);
    expect(svg.textContent).not.toContain("alert");
    expect(svg.querySelector("g.node[data-id='A'] foreignObject div p")?.textContent).toBe("label");
  });

  it("an SVG <style> is kept when plain, dropped whole when it references anything external", () => {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    const ok = document.createElementNS(NS, "style");
    ok.setAttribute("onload", "alert(1)");
    ok.textContent = "#d .node rect{fill:#ECECFF;stroke:url(#g)}";
    const bad = document.createElementNS(NS, "style");
    bad.textContent = "@import url(https://evil.test/a.css); .a{fill:red}";
    const bad2 = document.createElementNS(NS, "style");
    bad2.textContent = ".a{background:url(https://evil.test/x.png)}";
    svg.append(ok, bad, bad2);
    sanitizeSvgTree(svg);
    const styles = svg.querySelectorAll("style");
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toBe("#d .node rect{fill:#ECECFF;stroke:url(#g)}");
    expect(styles[0]!.attributes).toHaveLength(0);
  });

  it("cleanSvgCss drops anything that could load or run, and keeps plain CSS", () => {
    expect(cleanSvgCss(".a{fill:#fff;stroke:url(#g)}")).toBe(".a{fill:#fff;stroke:url(#g)}");
    // An escape can't smuggle a url(: any backslash rejects the CSS.
    expect(cleanSvgCss("a{b:u\\72l(https://x)}")).toBeNull();
    for (const bad of ["@import 'x.css'", ".a{background:url(https://x)}", ".a{background:url(//x)}",
      ".a{background:image-set('https://x' 1x)}", "x:expression(alert(1))", "a{behavior:url(#x)}", "</style><script>"]) {
      expect(cleanSvgCss(bad), bad).toBeNull();
    }
  });

  it("finds only the outermost block and maps code.language-mermaid to its pre", () => {
    const doc = parse("<div class=\"mermaid\"><pre class=\"mermaid\">x</pre></div><pre><code class=\"language-mermaid\">y</code></pre><code class=\"language-mermaid\">z</code>");
    expect(findMermaidBlocks(doc).map((e) => e.localName)).toEqual(["div", "pre", "code"]);
  });

  it("stays fast on a deep, wide hostile SVG", () => {
    const deep = "<g>".repeat(5_000) + "</g>".repeat(5_000);
    const wide = "<foreignObject><div>" + "<span onclick=x>a</span>".repeat(20_000) + "</div></foreignObject>";
    const start = performance.now();
    expect(sanitizeMermaidSvg(`<svg>${deep}${wide}</svg>`)).not.toBeNull();
    expect(performance.now() - start).toBeLessThan(5_000);
  });
});
