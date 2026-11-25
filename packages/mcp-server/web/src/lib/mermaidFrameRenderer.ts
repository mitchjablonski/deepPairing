/**
 * #714 gap 11 — the parent side of the isolated Mermaid renderer.
 *
 * Page diagrams are NOT rendered in the companion's own document: Mermaid lays
 * out in a live DOM, so labels or `themeCSS` could make the trusted origin
 * fetch agent-chosen URLs, and a stalled render would block Mermaid's global
 * queue for the whole tab. Instead a hidden `sandbox="allow-scripts"` iframe
 * (opaque origin, no-network CSP, see mermaid-renderer.html) does the work and
 * posts back an SVG string, which pageMermaid.ts sanitizes in the parent on a
 * DOMParser document before injecting it into the page.
 *
 * Cancellation is real: aborting a request DESTROYS the frame (killing a hung
 * or long render) and the next request gets a fresh one, so nothing queues
 * behind abandoned work. The plan-card MermaidDiagram keeps its own renderer
 * and shares no Mermaid state with this one.
 */
import {
  MERMAID_RENDERER_PATH, MermaidRendererMessageSchema, type MermaidRenderRequest,
} from "./mermaidRendererProtocol";
import type { MermaidRenderer, PageTheme } from "./pageMermaid";

/** A live renderer frame: where to post, and how to tear it down. */
export interface RendererFrame {
  /** The frame's window (compared with `event.source`, and posted to). */
  target: { postMessage(message: unknown, targetOrigin: string): void };
  destroy(): void;
}

export interface FrameRendererDeps {
  createFrame: () => RendererFrame;
  /** Subscribe to messages arriving at the parent window. */
  listen: (handler: (event: { source: unknown; data: unknown }) => void) => () => void;
}

export class RendererAbortError extends Error {
  constructor() {
    super("render aborted");
    this.name = "RendererAbortError";
  }
}

export class RendererFailedError extends Error {}

interface Pending {
  reqId: string;
  resolve: (svg: string) => void;
  reject: (err: Error) => void;
}

export class MermaidFrameRenderer {
  private frame: RendererFrame | null = null;
  private ready: Promise<void> | null = null;
  private markReady: (() => void) | null = null;
  private pending: Pending | null = null;
  private unlisten: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
  /** Frames created so far (observability for tests). */
  framesCreated = 0;

  constructor(private readonly deps: FrameRendererDeps) {}

  /** A MermaidRenderer bound to this instance; requests run one at a time. */
  readonly render: MermaidRenderer = (id, source, theme, signal) => {
    const run = () => this.renderOne(id, source, theme, signal);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  };

  /** Tear down the frame (and fail any in-flight request). */
  dispose(): void {
    this.destroyFrame(new RendererAbortError());
    this.unlisten?.();
    this.unlisten = null;
  }

  private onMessage = (event: { source: unknown; data: unknown }): void => {
    if (!this.frame || event.source !== this.frame.target) return;
    const parsed = MermaidRendererMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.type === "dp-mermaid-ready") {
      this.markReady?.();
      return;
    }
    const p = this.pending;
    if (!p || msg.reqId !== p.reqId) return;
    this.pending = null;
    if (msg.type === "dp-mermaid-result") p.resolve(msg.svg);
    else p.reject(new RendererFailedError(msg.error));
  };

  private ensureFrame(): Promise<void> {
    if (!this.unlisten) this.unlisten = this.deps.listen(this.onMessage);
    if (this.frame && this.ready) return this.ready;
    this.ready = new Promise<void>((resolve) => { this.markReady = resolve; });
    this.frame = this.deps.createFrame();
    this.framesCreated++;
    return this.ready;
  }

  private destroyFrame(reason: Error): void {
    const p = this.pending;
    this.pending = null;
    if (this.frame) {
      try { this.frame.destroy(); } catch { /* already gone */ }
    }
    this.frame = null;
    this.ready = null;
    this.markReady = null;
    p?.reject(reason);
  }

  private renderOne(id: string, source: string, theme: PageTheme, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new RendererAbortError());
    return new Promise<string>((resolve, reject) => {
      const reqId = `r${++this.seq}`;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        // Kill the frame: whatever it is doing (a hung image, a layout bomb)
        // dies with it, and the next request starts on a fresh frame.
        this.destroyFrame(new RendererAbortError());
        finish(() => reject(new RendererAbortError()));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.ensureFrame().then(() => {
        if (settled || !this.frame) return;
        this.pending = {
          reqId,
          resolve: (svg) => finish(() => resolve(svg)),
          reject: (err) => finish(() => reject(err)),
        };
        const req: MermaidRenderRequest = { type: "dp-mermaid-render", reqId, id, source, theme };
        this.frame.target.postMessage(req, "*");
      });
    });
  }
}

/** The real frame: hidden, laid out off-screen (Mermaid needs layout, so not
 *  display:none), sandboxed without allow-same-origin. */
export function createSandboxedRendererFrame(): RendererFrame {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("tabindex", "-1");
  iframe.setAttribute("title", "Diagram renderer");
  iframe.setAttribute("data-dp-mermaid-renderer", "");
  iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;pointer-events:none";
  iframe.src = MERMAID_RENDERER_PATH;
  document.body.appendChild(iframe);
  const target = iframe.contentWindow;
  if (!target) {
    iframe.remove();
    throw new RendererFailedError("renderer frame has no window");
  }
  return { target, destroy: () => iframe.remove() };
}

function listenToWindow(handler: (event: { source: unknown; data: unknown }) => void): () => void {
  const fn = (e: MessageEvent) => handler({ source: e.source, data: e.data });
  window.addEventListener("message", fn);
  return () => window.removeEventListener("message", fn);
}

let shared: MermaidFrameRenderer | null = null;

/** The companion-wide renderer (created on first use). */
export function sharedMermaidFrameRenderer(): MermaidFrameRenderer {
  if (!shared) shared = new MermaidFrameRenderer({ createFrame: createSandboxedRendererFrame, listen: listenToWindow });
  return shared;
}
