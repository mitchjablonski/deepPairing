/**
 * Shared API helpers for the companion web UI.
 * Includes session-aware headers for daemon routing.
 *
 * Safe to import in non-browser contexts (SSR, node test runners): `window`
 * access is guarded so module load doesn't throw.
 */

// MP1 (multi-project spike) — the host:port the SPA currently talks to.
// Defaults to the page's own origin (the daemon that served the HTML), but the
// project switcher can repoint it at another project's daemon (a different
// localhost port). Cross-origin is already allowed: the daemon's CORS + WS
// origin guard are hostname-only (port-agnostic). Mutable module state read by
// API_BASE / wsBase / sessionHeaders so a switch doesn't require reload.
const defaultHost =
  typeof window !== "undefined" && window.location?.host ? window.location.host : "";
let currentHost = defaultHost;

/** Repoint the SPA at a project's daemon host:port (e.g. "localhost:3851"). */
export function setCurrentHost(host: string): void {
  currentHost = host || defaultHost;
}
export function getCurrentHost(): string {
  return currentHost;
}

/** Current daemon HTTP base, e.g. "http://localhost:3851". Reads the live
 *  switchable host so callers always hit the selected project. */
export function apiBase(): string {
  return currentHost ? `http://${currentHost}` : "";
}
/** Current daemon WS base, e.g. "ws://localhost:3851/ws". */
export function wsBase(): string {
  return currentHost ? `ws://${currentHost}/ws` : "";
}

// Back-compat: existing call sites import API_BASE as a const. It still
// reflects the ORIGIN host (pre-switch). New/switch-aware code should call
// apiBase() instead. Kept so the spike doesn't have to touch every call site.
export const API_BASE = defaultHost ? `http://${defaultHost}` : "";

/** Get headers with session ID for daemon routing */
export function sessionHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window === "undefined") return headers;
  try {
    const connState = (window as any).__dpConnectionStore?.getState?.();
    if (connState?.sessionId) {
      headers["X-Session-Id"] = connState.sessionId;
    }
    // AA4 — pair the sessionId with the daemon's projectHash so a
    // stale-tab race after daemon restart on the same port is caught
    // with a 403 project_hash_mismatch instead of silently routing the
    // mutation into the wrong project's first session.
    if (connState?.projectHash) {
      headers["X-Project-Hash"] = connState.projectHash;
    }
    // SP1 — carry the daemon's bearer token (injected into the served HTML as
    // window.__deepPairingToken) so the now-bearer-gated MUTATION routes accept
    // browser writes. Reads ignore it. Same token /api/files + /api/prompts use.
    const token = (window as any).__deepPairingToken;
    if (typeof token === "string" && token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  } catch {}
  return headers;
}

/**
 * Read a daemon route with the session + project headers attached. The II2
 * fail-closed gate 403s any /api/* request without X-Project-Hash, so every
 * read MUST carry it (stores/ledger.ts is the template). Accepts an absolute
 * URL or a path. Returns the raw Response WITHOUT throwing — read paths often
 * treat a 404 / empty body as meaningful, unlike safeFetch (use that for
 * mutations). Any caller-supplied headers override the session ones.
 */
export async function apiGet(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...sessionHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
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
