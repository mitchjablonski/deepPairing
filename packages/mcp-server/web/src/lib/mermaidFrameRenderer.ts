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
 * behind abandoned work. Otherwise the frame stays warm across pages.
 *
 * Availability. A host that can NEVER load the frame (a non-http(s) page
 * with no daemon origin to load it from, or `createFrame` throwing) marks the
 * renderer unavailable for the session: every request fails at once with source and
 * an "open the browser companion" note. On http(s) the frame gets its own
 * ready deadline (10 s; cold load is NOT charged to any diagram's render
 * timeout). A miss there is treated like a timeout, not a verdict: the
 * request fails fast for a 30 s backoff, then the next mount retries; after
 * 3 consecutive misses the tab gives up with a "reload to retry" message. The plan-card MermaidDiagram keeps its own renderer
 * and shares no Mermaid state with this one.
 *
 * #727 — the VS Code webview. There the companion's document is NOT served by
 * the daemon: it is the extension's bundled copy at a `vscode-webview:` origin,
 * so the relative renderer path would resolve inside the webview, not at the
 * daemon. The extension names the daemon it already trusts in a
 * `<meta name="deeppairing-daemon-origin">` (and allows exactly that origin in
 * the webview CSP's `frame-src`); `rendererUrlForHost` accepts only a loopback
 * `http://host:port` there and points the frame at the daemon's renderer page.
 * The frame itself is unchanged: same sandbox, same no-network CSP.
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
  /** How long a new frame may take to post "ready" (default 10 s). */
  readyTimeoutMs?: number;
  /** After a missed ready, fail fast for this long before retrying (30 s). */
  readyBackoffMs?: number;
  /** Consecutive missed readies before the tab gives up (3). */
  maxReadyMisses?: number;
  /** Start out unavailable (a host that can't load the frame at all). */
  unavailable?: boolean;
}

/** Default deadline for a new frame's "ready". */
export const MERMAID_RENDERER_READY_TIMEOUT_MS = 10_000;
export const MERMAID_RENDERER_READY_BACKOFF_MS = 30_000;
export const MERMAID_RENDERER_MAX_READY_MISSES = 3;

export class RendererAbortError extends Error {
  constructor() {
    super("render aborted");
    this.name = "RendererAbortError";
  }
}

export class RendererFailedError extends Error {}

/** The renderer frame can never run on this host (non-http(s) page, or the
 *  frame couldn't be created). */
export class RendererUnavailableError extends Error {
  constructor() {
    super("diagram renderer unavailable");
    this.name = "RendererUnavailableError";
  }
}

/** The frame missed its ready deadline (or we're in the backoff after one):
 *  timeout-like, retried on a later mount. */
export class RendererColdError extends Error {
  constructor() {
    super("diagram renderer did not load in time");
    this.name = "RendererColdError";
  }
}

/** The frame missed its ready deadline too many times in this tab. */
export class RendererExhaustedError extends Error {
  constructor() {
    super("diagram renderer could not load in this tab");
    this.name = "RendererExhaustedError";
  }
}

interface Pending {
  reqId: string;
  resolve: (svg: string) => void;
  reject: (err: Error) => void;
}

export class MermaidFrameRenderer {
  private frame: RendererFrame | null = null;
  private ready: Promise<void> | null = null;
  private markReady: (() => void) | null = null;
  private failReady: ((err: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Session-wide: this host can never run the frame. */
  unavailable: boolean;
  /** Consecutive missed readies (reset by a ready). */
  readyMisses = 0;
  /** No new frame before this time (ms epoch) after a missed ready. */
  private backoffUntil = 0;
  private pending: Pending | null = null;
  private unlisten: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
  /** Frames created so far (observability for tests). */
  framesCreated = 0;

  constructor(private readonly deps: FrameRendererDeps) {
    this.unavailable = !!deps.unavailable;
    this.render = Object.assign(
      (id: string, source: string, theme: PageTheme, signal?: AbortSignal, onStart?: () => void) => {
        const blocked = this.blockedError();
        if (blocked) return Promise.reject(blocked);
        const run = () => this.renderOne(id, source, theme, signal, onStart);
        const p = this.chain.then(run, run);
        this.chain = p.catch(() => undefined);
        return p;
      },
      // The render timeout starts at onStart (request posted to a READY
      // frame), so a cold load never counts against a diagram.
      { reportsStart: true },
    );
  }

  /** A MermaidRenderer bound to this instance; requests run one at a time. */
  readonly render: MermaidRenderer;

  /** Why a request must fail without trying, if it must. */
  private blockedError(): Error | null {
    if (this.unavailable) return new RendererUnavailableError();
    if (this.readyMisses >= (this.deps.maxReadyMisses ?? MERMAID_RENDERER_MAX_READY_MISSES)) return new RendererExhaustedError();
    if (!this.frame && Date.now() < this.backoffUntil) return new RendererColdError();
    return null;
  }

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
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.readyMisses = 0;
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
    this.ready = new Promise<void>((resolve, reject) => { this.markReady = resolve; this.failReady = reject; });
    this.ready.catch(() => undefined);
    try {
      this.frame = this.deps.createFrame();
    } catch {
      this.unavailable = true;
      const failed = this.ready;
      this.destroyFrame(new RendererUnavailableError());
      return failed;
    }
    this.framesCreated++;
    this.readyTimer = setTimeout(() => {
      // A slow cold load is not a verdict on the host: back off, then retry.
      this.readyTimer = null;
      this.readyMisses++;
      this.backoffUntil = Date.now() + (this.deps.readyBackoffMs ?? MERMAID_RENDERER_READY_BACKOFF_MS);
      const capped = this.readyMisses >= (this.deps.maxReadyMisses ?? MERMAID_RENDERER_MAX_READY_MISSES);
      this.destroyFrame(capped ? new RendererExhaustedError() : new RendererColdError());
    }, this.deps.readyTimeoutMs ?? MERMAID_RENDERER_READY_TIMEOUT_MS);
    return this.ready;
  }

  private destroyFrame(reason: Error): void {
    const p = this.pending;
    this.pending = null;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.failReady?.(reason);
    if (this.frame) {
      try { this.frame.destroy(); } catch { /* already gone */ }
    }
    this.frame = null;
    this.ready = null;
    this.markReady = null;
    this.failReady = null;
    p?.reject(reason);
  }

  private renderOne(id: string, source: string, theme: PageTheme, signal?: AbortSignal, onStart?: () => void): Promise<string> {
    if (signal?.aborted) return Promise.reject(new RendererAbortError());
    // Re-check: a request queued before the renderer was marked unavailable
    // (or entered backoff) must not create a frame.
    const blocked = this.blockedError();
    if (blocked) return Promise.reject(blocked);
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
        onStart?.();
      }, (err: Error) => finish(() => reject(err)));
    });
  }
}

/** The real frame: hidden, laid out off-screen (Mermaid needs layout, so not
 *  display:none), sandboxed without allow-same-origin. */
export function createSandboxedRendererFrame(src: string = MERMAID_RENDERER_PATH): RendererFrame {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("tabindex", "-1");
  iframe.setAttribute("title", "Diagram renderer");
  iframe.setAttribute("data-dp-mermaid-renderer", "");
  iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;pointer-events:none";
  iframe.src = src;
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

/** The renderer page is served by the daemon over http(s). Any other host
 *  (the VS Code webview's `vscode-webview:`, `file:`) can't load it from its
 *  own origin. */
export function rendererHostSupported(protocol: string | undefined): boolean {
  return protocol === "http:" || protocol === "https:";
}

/** Meta tag the VS Code extension sets to the daemon origin it trusts. */
export const DAEMON_ORIGIN_META = "deeppairing-daemon-origin";

/** A loopback daemon origin, exactly `http://<loopback>:<port>` (no path,
 *  credentials, query or trailing slash). */
const LOOPBACK_DAEMON_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;

/** Where to load the renderer page from on this host, or null when it can't
 *  load at all. A valid embedder-named daemon origin wins (the VS Code
 *  webview, whose location may be `vscode-webview:` or, on VS Code for Web,
 *  `https:`); only a loopback `http://host:port` counts. Otherwise a
 *  daemon-served page (http/https) uses the relative path, as before. */
export function rendererUrlForHost(protocol: string | undefined, daemonOrigin: string | null | undefined): string | null {
  const origin = daemonOrigin?.trim() ?? "";
  const m = LOOPBACK_DAEMON_ORIGIN.exec(origin);
  if (m && Number(m[1]) <= 65535) return `${origin}${MERMAID_RENDERER_PATH}`;
  return rendererHostSupported(protocol) ? MERMAID_RENDERER_PATH : null;
}

/** The embedder's daemon-origin meta, read from `<head>` only (the shared
 *  renderer reads it once, when first created). */
export function readDaemonOriginMeta(): string | null {
  if (typeof document === "undefined") return null;
  return document.querySelector(`head > meta[name="${DAEMON_ORIGIN_META}"]`)?.getAttribute("content") ?? null;
}

let shared: MermaidFrameRenderer | null = null;

/** The companion-wide renderer (created on first use). On a host with no
 *  renderer URL it starts unavailable: no frame is ever created, no time is
 *  spent. */
export function sharedMermaidFrameRenderer(): MermaidFrameRenderer {
  if (!shared) {
    const src = rendererUrlForHost(typeof location === "undefined" ? undefined : location.protocol, readDaemonOriginMeta());
    shared = new MermaidFrameRenderer({
      createFrame: () => createSandboxedRendererFrame(src ?? MERMAID_RENDERER_PATH),
      listen: listenToWindow,
      unavailable: src === null,
    });
  }
  return shared;
}
