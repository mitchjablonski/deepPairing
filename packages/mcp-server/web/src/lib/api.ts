/**
 * Shared API helpers for the companion web UI.
 * Includes session-aware headers for daemon routing.
 *
 * Safe to import in non-browser contexts (SSR, node test runners): `window`
 * access is guarded so module load doesn't throw.
 */

export const API_BASE =
  typeof window !== "undefined" && window.location?.host
    ? `http://${window.location.host}`
    : "";

/** Get headers with session ID for daemon routing */
export function sessionHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window === "undefined") return headers;
  try {
    const connState = (window as any).__dpConnectionStore?.getState?.();
    if (connState?.sessionId) {
      headers["X-Session-Id"] = connState.sessionId;
    }
  } catch {}
  return headers;
}
