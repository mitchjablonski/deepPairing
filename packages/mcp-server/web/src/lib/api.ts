/**
 * Shared API helpers for the companion web UI.
 * Includes session-aware headers for daemon routing.
 */

export const API_BASE = `http://${window.location.host}`;

/** Get headers with session ID for daemon routing */
export function sessionHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const connState = (window as any).__dpConnectionStore?.getState?.();
    if (connState?.sessionId) {
      headers["X-Session-Id"] = connState.sessionId;
    }
  } catch {}
  return headers;
}
