/**
 * #714 gap 11 — the isolated renderer: parent-side frame manager and the
 * frame's own message handler. Fakes, not mocks: a fake frame whose window
 * runs the REAL renderer core (handleRendererMessage) against a fake Mermaid,
 * wired through a fake message bus with real `source` identities.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MermaidFrameRenderer, RendererAbortError, RendererFailedError, RendererUnavailableError, rendererHostSupported,
  MERMAID_RENDERER_READY_TIMEOUT_MS, type RendererFrame,
} from "../mermaidFrameRenderer";
import { PAGE_MERMAID_NOTES, renderPageMermaid } from "../pageMermaid";
import { MermaidRendererMessageSchema } from "../mermaidRendererProtocol";
import { handleRendererMessage, rendererConfig, MERMAID_RENDERER_SECURE_KEYS, type MermaidLike } from "../../mermaidRenderer/core";

type Handler = (event: { source: unknown; data: unknown }) => void;

/** A fake Mermaid: records init configs; `hang` sources never settle. */
class FakeMermaid implements MermaidLike {
  configs: Array<ReturnType<typeof rendererConfig>> = [];
  renders: string[] = [];
  initialize(config: ReturnType<typeof rendererConfig>) { this.configs.push(config); }
  render(id: string, text: string): Promise<{ svg: string }> {
    this.renders.push(text);
    if (text === "hang") return new Promise(() => {});
    if (text === "bad") return Promise.reject(new Error("Parse error on line 1"));
    return Promise.resolve({ svg: `<svg id="${id}"><g class="node" id="${id}-flowchart-A-0"></g></svg>` });
  }
}

/** A fake page: a message bus to the parent, and frames that run the real
 *  renderer core. Destroyed frames stop answering. */
function fakeHost(opts: { autoReady?: boolean } = {}) {
  const handlers = new Set<Handler>();
  const frames: Array<{ win: object; destroyed: boolean; mermaid: FakeMermaid; received: unknown[] }> = [];
  const toParent = (source: unknown, data: unknown) => {
    queueMicrotask(() => { for (const h of handlers) h({ source, data }); });
  };
  const createFrame = (): RendererFrame => {
    const mermaid = new FakeMermaid();
    const rec = { win: {} as object, destroyed: false, mermaid, received: [] as unknown[] };
    const win = {
      postMessage(message: unknown) {
        rec.received.push(message);
        if (rec.destroyed) return;
        // The frame checks event.source === window.parent; here the parent posts.
        void handleRendererMessage(message, true, mermaid).then((reply) => {
          if (reply && !rec.destroyed) toParent(win, reply);
        });
      },
    };
    rec.win = win;
    frames.push(rec);
    if (opts.autoReady !== false) toParent(win, { type: "dp-mermaid-ready" });
    return { target: win, destroy: () => { rec.destroyed = true; } };
  };
  const listen = (h: Handler) => { handlers.add(h); return () => handlers.delete(h); };
  return { createFrame, listen, frames, toParent };
}

describe("MermaidFrameRenderer (parent side)", () => {
  it("renders through the frame: request out, validated SVG back; one frame reused", async () => {
    const host = fakeHost();
    const r = new MermaidFrameRenderer(host);
    const svg = await r.render("dp-page-mermaid-0", "flowchart LR\n A[a]", "dark");
    expect(svg).toContain('id="dp-page-mermaid-0-flowchart-A-0"');
    await r.render("dp-page-mermaid-1", "flowchart LR\n B[b]", "light");
    expect(r.framesCreated).toBe(1);
    const sent = host.frames[0]!.received[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ type: "dp-mermaid-render", id: "dp-page-mermaid-0", source: "flowchart LR\n A[a]", theme: "dark" });
    expect(host.frames[0]!.mermaid.configs.map((c) => c.theme)).toEqual(["dark", "default"]);
  });

  it("a render error from the frame rejects as a failure (not an abort)", async () => {
    const r = new MermaidFrameRenderer(fakeHost());
    await expect(r.render("dp-page-mermaid-0", "bad", "light")).rejects.toBeInstanceOf(RendererFailedError);
  });

  it("ignores messages from anyone but the live frame, and malformed ones", async () => {
    const host = fakeHost({ autoReady: false });
    const r = new MermaidFrameRenderer(host);
    const p = r.render("dp-page-mermaid-0", "flowchart LR\n A[a]", "light");
    await Promise.resolve();
    const frameWin = host.frames[0]!.win;
    // A forged "ready" + result from another window is ignored.
    host.toParent({}, { type: "dp-mermaid-ready" });
    host.toParent({}, { type: "dp-mermaid-result", reqId: "r1", svg: "<svg>forged</svg>" });
    await new Promise((res) => setTimeout(res, 0));
    expect(host.frames[0]!.received).toHaveLength(0); // still waiting for the real ready
    // Malformed messages from the real frame are ignored too.
    host.toParent(frameWin, { type: "dp-mermaid-ready", extra: 1 });
    host.toParent(frameWin, "ready");
    await new Promise((res) => setTimeout(res, 0));
    expect(host.frames[0]!.received).toHaveLength(0);
    host.toParent(frameWin, { type: "dp-mermaid-ready" });
    await expect(p).resolves.toContain("flowchart-A-0");
  });

  it("abort DESTROYS the frame (killing the hung render) and the next request gets a fresh one", async () => {
    const host = fakeHost();
    const r = new MermaidFrameRenderer(host);
    const ctl = new AbortController();
    const hung = r.render("dp-page-mermaid-0", "hang", "light", ctl.signal);
    await new Promise((res) => setTimeout(res, 0));
    expect(host.frames[0]!.mermaid.renders).toEqual(["hang"]);
    ctl.abort();
    await expect(hung).rejects.toBeInstanceOf(RendererAbortError);
    expect(host.frames[0]!.destroyed).toBe(true);
    // Not queued behind the abandoned work: a new frame answers at once.
    await expect(r.render("dp-page-mermaid-1", "flowchart LR\n A[a]", "light")).resolves.toContain("<svg");
    expect(r.framesCreated).toBe(2);
    expect(host.frames[1]!.destroyed).toBe(false);
  });

  it("abort while the frame is still loading destroys it too; an already-aborted signal never creates one", async () => {
    const host = fakeHost({ autoReady: false });
    const r = new MermaidFrameRenderer(host);
    const ctl = new AbortController();
    const p = r.render("dp-page-mermaid-0", "flowchart LR\n A[a]", "light", ctl.signal);
    await Promise.resolve();
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(RendererAbortError);
    expect(host.frames[0]!.destroyed).toBe(true);
    const dead = new AbortController();
    dead.abort();
    await expect(r.render("dp-page-mermaid-0", "x", "light", dead.signal)).rejects.toBeInstanceOf(RendererAbortError);
    expect(r.framesCreated).toBe(1);
  });
});

describe("availability: ready deadline, non-http hosts, cold load", () => {
  afterEach(() => vi.useRealTimers());
  const PAGE = Array.from({ length: 3 }, (_, i) => `<pre class="mermaid">flowchart LR\n  N${i}[n]</pre>`).join("");
  const notes = (html: string) =>
    Array.from(new DOMParser().parseFromString(html, "text/html").querySelectorAll("[data-dp-mermaid-note]")).map((n) => n.textContent);

  it("a frame that never says ready (VS Code webview CSP) marks the renderer unavailable: one 3 s wait, then instant fallback", async () => {
    vi.useFakeTimers();
    const host = fakeHost({ autoReady: false });
    const r = new MermaidFrameRenderer(host);
    const start = Date.now();
    const p = renderPageMermaid(PAGE, { theme: "light", renderer: r.render });
    await vi.advanceTimersByTimeAsync(MERMAID_RENDERER_READY_TIMEOUT_MS);
    const out = await p;
    // No 15 s budget burn: everything settled at the ready deadline.
    expect(Date.now() - start).toBe(MERMAID_RENDERER_READY_TIMEOUT_MS);
    expect(out).toMatchObject({ rendered: 0, fallback: 3, timedOut: 0, unavailable: 3 });
    expect(notes(out.html)).toEqual(Array(3).fill(PAGE_MERMAID_NOTES.unavailable));
    expect(r.unavailable).toBe(true);
    expect(r.framesCreated).toBe(1);
    expect(host.frames[0]!.destroyed).toBe(true);
    // Session-wide: the next page fails over at once, with no new frame.
    const again = renderPageMermaid(PAGE, { theme: "light", renderer: r.render });
    await vi.advanceTimersByTimeAsync(0);
    expect((await again).unavailable).toBe(3);
    expect(r.framesCreated).toBe(1);
    await expect(r.render("dp-page-mermaid-0", "x", "light")).rejects.toBeInstanceOf(RendererUnavailableError);
  });

  it("a non-http(s) host skips the renderer entirely: no frame, immediate source + note", async () => {
    expect(rendererHostSupported("vscode-webview:")).toBe(false);
    expect(rendererHostSupported("file:")).toBe(false);
    expect(rendererHostSupported(undefined)).toBe(false);
    expect(rendererHostSupported("http:")).toBe(true);
    expect(rendererHostSupported("https:")).toBe(true);
    const host = fakeHost();
    const r = new MermaidFrameRenderer({ ...host, unavailable: !rendererHostSupported("vscode-webview:") });
    const out = await renderPageMermaid(PAGE, { theme: "dark", renderer: r.render });
    expect(out).toMatchObject({ rendered: 0, unavailable: 3 });
    expect(notes(out.html)).toEqual(Array(3).fill(PAGE_MERMAID_NOTES.unavailable));
    expect(r.framesCreated).toBe(0);
  });

  it("a cold load is not charged to the diagram's render timeout", async () => {
    vi.useFakeTimers();
    const host = fakeHost({ autoReady: false });
    const r = new MermaidFrameRenderer({ ...host, readyTimeoutMs: 3_000 });
    const p = renderPageMermaid(PAGE.slice(0, PAGE.indexOf("</pre>") + 6), { theme: "light", renderer: r.render, timeoutMs: 1_000, totalTimeoutMs: 10_000 });
    // The frame takes 2.5 s to load: longer than the 1 s render timeout.
    await vi.advanceTimersByTimeAsync(2_500);
    host.toParent(host.frames[0]!.win, { type: "dp-mermaid-ready" });
    await vi.advanceTimersByTimeAsync(10);
    const out = await p;
    expect(out).toMatchObject({ rendered: 1, fallback: 0, timedOut: 0 });
    expect(r.unavailable).toBe(false);
    expect(host.frames[0]!.destroyed).toBe(false);
  });

  it("the frame stays warm across pages (destroyed only on abort)", async () => {
    const host = fakeHost();
    const r = new MermaidFrameRenderer(host);
    await renderPageMermaid(PAGE, { theme: "light", renderer: r.render });
    await renderPageMermaid(PAGE, { theme: "dark", renderer: r.render });
    expect(r.framesCreated).toBe(1);
    expect(host.frames[0]!.destroyed).toBe(false);
  });
});

describe("renderer frame core (frame side)", () => {
  it("renders a valid request from the parent with the hardened config", async () => {
    const m = new FakeMermaid();
    const reply = await handleRendererMessage(
      { type: "dp-mermaid-render", reqId: "r1", id: "dp-page-mermaid-0", source: "flowchart LR\n A[a]", theme: "light" }, true, m,
    );
    expect(MermaidRendererMessageSchema.parse(reply)).toMatchObject({ type: "dp-mermaid-result", reqId: "r1" });
    const cfg = m.configs[0]!;
    expect(cfg).toMatchObject({ securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false }, startOnLoad: false, theme: "default" });
    for (const k of ["themeCSS", "themeVariables", "htmlLabels", "flowchart", "fontFamily", "altFontFamily", "securityLevel", "secure"]) {
      expect(cfg.secure).toContain(k);
    }
    expect(cfg.secure).toEqual([...MERMAID_RENDERER_SECURE_KEYS]);
  });

  it("ignores messages not from the parent and invalid requests", async () => {
    const m = new FakeMermaid();
    const ok = { type: "dp-mermaid-render", reqId: "r1", id: "dp-page-mermaid-0", source: "x", theme: "dark" };
    expect(await handleRendererMessage(ok, false, m)).toBeNull();
    for (const bad of [
      null, "render", { ...ok, type: "other" }, { ...ok, theme: "neon" }, { ...ok, id: "0bad id" }, { ...ok, reqId: "x".repeat(65) },
      { ...ok, source: "" }, { ...ok, source: "x".repeat(20_001) }, { ...ok, extra: true },
    ]) {
      expect(await handleRendererMessage(bad, true, m), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
    expect(m.renders).toHaveLength(0);
  });

  it("reports a render error, clipped, and always cleans up its temp node", async () => {
    const m = new FakeMermaid();
    const cleaned: string[] = [];
    const reply = await handleRendererMessage(
      { type: "dp-mermaid-render", reqId: "r2", id: "dp-page-mermaid-3", source: "bad", theme: "dark" }, true, m, (id) => cleaned.push(id),
    );
    expect(reply).toEqual({ type: "dp-mermaid-error", reqId: "r2", error: "Parse error on line 1" });
    expect(cleaned).toEqual(["dp-page-mermaid-3"]);
  });

  it("the parent rejects replies that break the schema (oversized SVG, unknown fields)", () => {
    expect(MermaidRendererMessageSchema.safeParse({ type: "dp-mermaid-result", reqId: "r1", svg: "x".repeat(1024 * 1024 + 1) }).success).toBe(false);
    expect(MermaidRendererMessageSchema.safeParse({ type: "dp-mermaid-result", reqId: "r1", svg: "<svg/>", html: "x" }).success).toBe(false);
    expect(MermaidRendererMessageSchema.safeParse({ type: "dp-mermaid-error", reqId: "r1", error: "x".repeat(301) }).success).toBe(false);
  });
});
