// @vitest-environment-options {"url":"https://webview.test/","settings":{"navigation":{"disableChildFrameNavigation":true,"disableChildPageNavigation":true}}}
/**
 * #727 — Mermaid page diagrams inside the VS Code webview.
 *
 * In the webview the companion document sits at a `vscode-webview:` origin,
 * not the daemon's, so the renderer page must be loaded from the daemon
 * origin the extension names (and only a loopback http origin is accepted).
 * The VS Code adapter must also ignore messages from the companion's own
 * sandboxed child frames, which now include the renderer in the webview.
 * Fakes, not mocks: a fake VS Code API object and real MessageEvents.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  DAEMON_ORIGIN_META, readDaemonOriginMeta, MermaidFrameRenderer, RendererUnavailableError, createSandboxedRendererFrame,
  rendererUrlForHost,
} from "../mermaidFrameRenderer";
import { MERMAID_RENDERER_PATH } from "../mermaidRendererProtocol";
import { VSCodeAdapter, isVSCodeHostMessage } from "../connection-adapter";

describe("rendererUrlForHost", () => {
  it("keeps the relative path on a daemon-served (http/https) page with no valid meta", () => {
    expect(rendererUrlForHost("http:", null)).toBe(MERMAID_RENDERER_PATH);
    expect(rendererUrlForHost("https:", "http://evil.example:80")).toBe(MERMAID_RENDERER_PATH);
  });

  it("prefers a valid meta origin even on an https host (VS Code for Web shape)", () => {
    expect(rendererUrlForHost("https:", "http://localhost:29901")).toBe(`http://localhost:29901${MERMAID_RENDERER_PATH}`);
  });

  it("uses the extension-named loopback daemon origin in the webview", () => {
    expect(rendererUrlForHost("vscode-webview:", "http://localhost:29901")).toBe(`http://localhost:29901${MERMAID_RENDERER_PATH}`);
    expect(rendererUrlForHost("vscode-webview:", "http://127.0.0.1:29901")).toBe(`http://127.0.0.1:29901${MERMAID_RENDERER_PATH}`);
    expect(rendererUrlForHost("vscode-webview:", "http://[::1]:29901")).toBe(`http://[::1]:29901${MERMAID_RENDERER_PATH}`);
  });

  it("is unavailable in the webview with no daemon origin", () => {
    expect(rendererUrlForHost("vscode-webview:", null)).toBeNull();
    expect(rendererUrlForHost("vscode-webview:", "")).toBeNull();
    expect(rendererUrlForHost(undefined, undefined)).toBeNull();
    expect(rendererUrlForHost("file:", null)).toBeNull();
  });

  it("rejects anything but an exact loopback http://host:port", () => {
    for (const bad of [
      "https://localhost:29901", // the daemon speaks plain http
      "http://localhost", // no port
      "http://localhost:29901/", // trailing path
      "http://localhost:29901/x",
      "http://localhost:0",
      "http://localhost:65536",
      "http://localhost:029901",
      "http://example.com:29901",
      "http://localhost.example.com:29901",
      "http://user@localhost:29901",
      "http://localhost:29901?x",
      "javascript:alert(1)//http://localhost:29901",
      "http://localhost:29901 http://evil:1",
    ]) {
      expect(rendererUrlForHost("vscode-webview:", bad), bad).toBeNull();
    }
  });
});

describe("the renderer frame in the webview", () => {
  afterEach(() => {
    document.querySelectorAll("iframe[data-dp-mermaid-renderer]").forEach((f) => f.remove());
    document.querySelectorAll(`meta[name="${DAEMON_ORIGIN_META}"]`).forEach((m) => m.remove());
  });

  it("points the sandboxed frame at the daemon's renderer page, sandbox unchanged", () => {
    const frame = createSandboxedRendererFrame(`http://localhost:29901${MERMAID_RENDERER_PATH}`);
    const iframe = document.querySelector("iframe[data-dp-mermaid-renderer]") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toBe(`http://localhost:29901${MERMAID_RENDERER_PATH}`);
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    frame.destroy();
    expect(document.querySelector("iframe[data-dp-mermaid-renderer]")).toBeNull();
  });

  it("defaults to the relative path for a daemon-served page", () => {
    const frame = createSandboxedRendererFrame();
    const iframe = document.querySelector("iframe[data-dp-mermaid-renderer]") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toBe(MERMAID_RENDERER_PATH);
    frame.destroy();
  });

  it("a webview with no daemon origin never creates a frame", async () => {
    let created = 0;
    const src = rendererUrlForHost("vscode-webview:", null);
    const r = new MermaidFrameRenderer({
      createFrame: () => { created++; return createSandboxedRendererFrame(src ?? MERMAID_RENDERER_PATH); },
      listen: () => () => {},
      unavailable: src === null,
    });
    await expect(r.render("dp-page-mermaid-0", "graph TD; A-->B", "light")).rejects.toBeInstanceOf(RendererUnavailableError);
    expect(created).toBe(0);
  });
});

describe("readDaemonOriginMeta", () => {
  afterEach(() => { document.querySelectorAll(`meta[name="${DAEMON_ORIGIN_META}"]`).forEach((m) => m.remove()); });

  it("reads the meta from <head>", () => {
    const m = document.createElement("meta");
    m.setAttribute("name", DAEMON_ORIGIN_META);
    m.setAttribute("content", "http://localhost:29901");
    document.head.appendChild(m);
    expect(readDaemonOriginMeta()).toBe("http://localhost:29901");
  });

  it("ignores a same-named meta outside <head>", () => {
    const m = document.createElement("meta");
    m.setAttribute("name", DAEMON_ORIGIN_META);
    m.setAttribute("content", "http://localhost:29901");
    document.body.appendChild(m);
    expect(readDaemonOriginMeta()).toBeNull();
  });
});

describe("VSCodeAdapter ignores sandboxed child frames", () => {
  const w = window as unknown as { acquireVsCodeApi?: () => { postMessage(m: unknown): void } };
  afterEach(() => { delete w.acquireVsCodeApi; });

  it("only messages from the webview's own origin are host messages", () => {
    const self = "vscode-webview://abc";
    expect(isVSCodeHostMessage({ origin: self }, self)).toBe(true);
    expect(isVSCodeHostMessage({ origin: "null" }, self)).toBe(false);
    expect(isVSCodeHostMessage({ origin: "" }, self)).toBe(false);
    expect(isVSCodeHostMessage({ origin: "http://localhost:29901" }, self)).toBe(false);
  });

  it("drops a dp:message posted by a sandboxed frame, keeps the host's", () => {
    const posted: unknown[] = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
    const adapter = new VSCodeAdapter();
    const got: unknown[] = [];
    adapter.onMessage((d) => got.push(d));
    adapter.connect();
    expect(posted).toEqual([{ type: "dp:ready" }]);

    window.dispatchEvent(new MessageEvent("message", { origin: "null", data: { type: "dp:message", data: { type: "fake" } } }));
    expect(got).toEqual([]);

    window.dispatchEvent(new MessageEvent("message", { origin: "http://localhost:29901", data: { type: "dp:message", data: { type: "daemon-frame" } } }));
    expect(got).toEqual([]);

    window.dispatchEvent(new MessageEvent("message", { origin: location.origin, data: { type: "dp:message", data: { type: "real" } } }));
    expect(got).toEqual([{ type: "real" }]);

    // Malformed host data is ignored rather than thrown on.
    window.dispatchEvent(new MessageEvent("message", { origin: location.origin, data: null }));
    expect(got).toHaveLength(1);
  });
});
