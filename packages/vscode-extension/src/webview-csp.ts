/**
 * #727 — the webview's Content-Security-Policy and daemon-origin hint.
 *
 * Pure (no `vscode` import) so it is unit-testable.
 *
 * Page Mermaid diagrams render in a hidden, sandboxed renderer iframe the
 * daemon serves at `/mermaid-renderer.html` (no-network CSP of its own). In
 * the webview the companion document is the extension's bundled copy at a
 * `vscode-webview:` origin, so two things are needed for that frame to load:
 *
 *  - `frame-src` naming the daemon. Without it the policy's
 *    `default-src 'none'` blocks every frame. Only the exact
 *    `http://localhost:<port>` the extension already connects to is allowed,
 *    and only once a port was actually read from `.deeppairing/daemon.json`.
 *  - a `<meta name="deeppairing-daemon-origin">` telling the companion where
 *    the renderer lives (the relative path would resolve inside the webview).
 *
 * The renderer's own sandbox and CSP are untouched.
 */

/** Matches DAEMON_ORIGIN_META in the companion's mermaidFrameRenderer.ts. */
export const DAEMON_ORIGIN_META = "deeppairing-daemon-origin";

/** A TCP port the webview may frame, or null. */
export function validDaemonPort(port: number | null | undefined): number | null {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** The daemon origin the extension trusts, or null when no port is known. */
export function daemonOrigin(port: number | null | undefined): string | null {
  const p = validDaemonPort(port);
  return p === null ? null : `http://localhost:${p}`;
}

/** The webview CSP. `daemonPort` null means no daemon was discovered: no
 *  frame is allowed at all, and diagrams fall back to source. */
export function buildWebviewCsp(cspSource: string, daemonPort: number | null): string {
  const origin = daemonOrigin(daemonPort);
  const parts = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src ${cspSource}`,
    `font-src ${cspSource}`,
    `img-src ${cspSource} data:`,
    "connect-src ws://localhost:* http://localhost:*",
  ];
  if (origin) parts.push(`frame-src ${origin}`);
  return parts.join("; ") + ";";
}

/** The `<head>` additions for the webview document: the CSP meta and, when a
 *  daemon is known, the daemon-origin meta. */
export function webviewHeadTags(cspSource: string, daemonPort: number | null): string {
  const tags = [`<meta http-equiv="Content-Security-Policy" content="${buildWebviewCsp(cspSource, daemonPort)}">`];
  const origin = daemonOrigin(daemonPort);
  if (origin) tags.push(`<meta name="${DAEMON_ORIGIN_META}" content="${origin}">`);
  return tags.join("\n");
}
