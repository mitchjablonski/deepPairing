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

/**
 * U3 — typed error thrown by safeFetch when a request fails. Carries enough
 * to render an actionable toast: HTTP status, the daemon's structured error
 * code (when present), and a human-readable message.
 *
 * Field-bug context: pre-U3, every store mutation (`submitComment`,
 * `updateArtifactStatus`, `resolveDecision`, `renameArtifact`) called
 * `await fetch(...)` and dropped the response. A 4xx/5xx — or a network
 * blip — was indistinguishable from success: the optimistic UI showed
 * the change, the daemon's store stayed empty, and the agent never saw
 * the comment / approval. The 10-minute "approve doesn't land" loop the
 * user reported was exactly this failure pattern.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    /** The daemon's structured error code, e.g. "no_active_session" (U0.6). */
    public readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Wrapper around `fetch` that throws ApiError on non-2xx responses and on
 * network failures. Use for every mutating call. Read paths can keep using
 * raw fetch when a 404 / empty response is meaningful (e.g. /api/state).
 *
 * The error message is tuned for toast display — short, blame-free, and
 * tells the user what they can try. Daemon's structured errors win when
 * present; otherwise we synthesize a generic "couldn't reach the daemon"
 * message that points at the doctor command.
 */
export async function safeFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err: any) {
    throw new ApiError(0, "network_error", `Couldn't reach the daemon. Run \`npx deeppairing doctor\` to diagnose.`);
  }
  if (res.ok) return res;

  // Try to parse a structured { error, code } body from the daemon. Ignore
  // parse failures — we still want to throw with the status and a generic
  // message so the caller can toast something useful.
  let code: string | null = null;
  let message = `Request failed (${res.status}).`;
  try {
    const body = await res.clone().json();
    if (typeof body?.code === "string") code = body.code;
    if (typeof body?.error === "string") message = body.error;
  } catch {
    // non-JSON body; keep the generic message
  }

  // Specialize known codes for clearer toast copy. Other codes pass through
  // with the daemon-supplied message.
  if (code === "no_active_session") {
    // U6 — point users at the doctor command alongside the action they
    // need to take. If "start Claude Code" doesn't work the next thing
    // they should reach for is the diagnostic.
    message = "No active deepPairing session. Start Claude Code with deepPairing configured, or run `npx deeppairing doctor --fix`.";
  }

  throw new ApiError(res.status, code, message);
}
