/**
 * D5 — browser-origin policy for the daemon's HTTP + WS surfaces.
 *
 * Threat model recap (verified end-to-end in the round-3 security review):
 * the old policy allowed ANY loopback origin, so a hostile page on
 * localhost:3000 could (a) fetch the served index.html cross-origin and READ
 * IT — stealing the injected bearer token, i.e. full mutation access, and
 * (b) open a WebSocket (WS ignores CORS; only the Origin check guards it)
 * for a live artifact stream.
 *
 * New policy: the only legitimate CROSS-origin browser consumer is the
 * VS Code webview (scheme vscode-webview://, which a web page cannot spoof —
 * browsers set Origin, pages don't). Everything else is same-origin (the SPA
 * is served by this daemon) or non-browser (curl/tests/daemon-to-daemon
 * sweep — no Origin header; CORS doesn't apply and never blocked them).
 *
 * Explicitly ACCEPTED residual: local PROCESSES. A user-level process can
 * read the token file (or ~/.deeppairing itself) directly — the filesystem
 * is that boundary, not HTTP. This policy closes the BROWSER class.
 */

/** CORS allowlist: only the VS Code webview may read cross-origin responses. */
export function corsAllowedOrigin(origin: string): string | undefined {
  if (origin.startsWith("vscode-webview://")) return origin;
  return undefined;
}

/** Loopback hostname check (mirrors guards.ts — the WS upgrade runs on the
 *  raw server 'upgrade' event and BYPASSES the Hono loopback-Host guard). */
function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * WS upgrade origin gate. Allowed:
 *  - no Origin (curl / tests / non-browser clients — can't be a browser page),
 *  - the daemon's OWN origin (same host:port as the request's Host header),
 *    AND that host is loopback — D5 review: same-origin alone passes under
 *    DNS rebinding (Origin evil.com + Host evil.com match each other, and
 *    this raw-upgrade path bypasses the Hono loopback-Host guard),
 *  - the VS Code webview scheme.
 * A different loopback port is exactly the attacker (old policy let it in).
 */
export function isAllowedWsOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true;
  if (origin.startsWith("vscode-webview://")) return true;
  if (!hostHeader) return false;
  try {
    const o = new URL(origin);
    return o.host === hostHeader && isLoopbackHostname(o.hostname);
  } catch {
    return false;
  }
}
