import { describe, expect, it } from "vitest";
import { DAEMON_ORIGIN_META, buildWebviewCsp, daemonOrigin, validDaemonPort, webviewHeadTags } from "../src/webview-csp";

const SRC = "https://abc.vscode-cdn.net";

function directive(csp: string, name: string): string | undefined {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
}

describe("#727 webview CSP for the Mermaid renderer frame", () => {
  it("allows exactly the discovered daemon origin as a frame source", () => {
    const csp = buildWebviewCsp(SRC, 29901);
    expect(directive(csp, "frame-src")).toBe("frame-src http://localhost:29901");
    expect(directive(csp, "default-src")).toBe("default-src 'none'");
    // No wildcard port, no other scheme, no child-src fallback widening.
    expect(csp).not.toMatch(/frame-src[^;]*\*/);
    expect(directive(csp, "child-src")).toBeUndefined();
  });

  it("keeps every pre-existing directive unchanged", () => {
    const csp = buildWebviewCsp(SRC, 29901);
    expect(directive(csp, "script-src")).toBe(`script-src ${SRC}`);
    expect(directive(csp, "style-src")).toBe(`style-src ${SRC} 'unsafe-inline'`);
    expect(directive(csp, "font-src")).toBe(`font-src ${SRC}`);
    expect(directive(csp, "img-src")).toBe(`img-src ${SRC} data:`);
    expect(directive(csp, "connect-src")).toBe("connect-src ws://localhost:* http://localhost:*");
  });

  it("allows no frame at all when no daemon port was discovered", () => {
    expect(directive(buildWebviewCsp(SRC, null), "frame-src")).toBeUndefined();
  });

  it("rejects ports that are not a real TCP port", () => {
    for (const bad of [0, -1, 65536, 29901.5, Number.NaN, null, undefined]) {
      expect(validDaemonPort(bad as number | null | undefined)).toBeNull();
      expect(daemonOrigin(bad as number | null | undefined)).toBeNull();
      expect(directive(buildWebviewCsp(SRC, bad as number | null), "frame-src")).toBeUndefined();
    }
    expect(daemonOrigin(65535)).toBe("http://localhost:65535");
  });

  it("head tags carry the CSP and the daemon-origin meta for the same port", () => {
    const tags = webviewHeadTags(SRC, 29901);
    expect(tags).toContain('http-equiv="Content-Security-Policy"');
    expect(tags).toContain(`<meta name="${DAEMON_ORIGIN_META}" content="http://localhost:29901">`);
  });

  it("head tags omit the daemon-origin meta when no daemon is known", () => {
    const tags = webviewHeadTags(SRC, null);
    expect(tags).toContain('http-equiv="Content-Security-Policy"');
    expect(tags).not.toContain(DAEMON_ORIGIN_META);
  });

  it("names the same meta the companion reads", async () => {
    // Keep the two packages' constant in lockstep without a runtime import
    // of the web bundle: read the companion source text.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "../../mcp-server/web/src/lib/mermaidFrameRenderer.ts"), "utf-8");
    expect(src).toContain(`export const DAEMON_ORIGIN_META = "${DAEMON_ORIGIN_META}";`);
  });
});
