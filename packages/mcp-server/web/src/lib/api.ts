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
// origin guard were loosened pre-D5; post-D5 switching NAVIGATES, so this
// mutable host only ever equals the page origin in production (tests aside).
// Mutable module state read by
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

/**
 * Bug A — is `sessionId` owned by a daemon OTHER than the one this tab is
 * bound to? A mutation's owning session is routed by the X-Session-Id header
 * only (F6) — NOT the port or credentials — so a write for a session served by
 * a different daemon (e.g. a stale tab after a port rebind, or an artifact that
 * belongs to another project) POSTs to the CURRENT daemon, which returns
 * null from getStore(sid) (AA4) → 409/404 → the optimistic patch rolls back and
 * the approval is silently lost.
 *
 * Conservative on purpose: returns false when the owner is unknown, is the
 * tab's own session, or the active-session set hasn't hydrated yet (empty).
 * That keeps SAME-daemon multi-session writes (the F6 common case) working
 * exactly as before — we only ever declare "foreign" when we positively KNOW
 * this daemon's session set and the owner isn't in it.
 */
export function isForeignSession(sessionId: string | undefined): boolean {
  if (!sessionId || typeof window === "undefined") return false;
  try {
    type ConnLike = { sessionId?: string | null; activeSessions?: Array<{ sessionId: string }> };
    const store = (window as unknown as {
      __dpConnectionStore?: { getState?: () => ConnLike };
    }).__dpConnectionStore;
    const conn = store?.getState?.();
    if (!conn) return false;
    // The tab's own bound session is never foreign, even before the active list
    // arrives (registration is async).
    if (sessionId === conn.sessionId) return false;
    const active: Array<{ sessionId: string }> = conn.activeSessions ?? [];
    // Not hydrated yet → we can't say it's foreign; don't block.
    if (active.length === 0) return false;
    return !active.some((s) => s.sessionId === sessionId);
  } catch {
    return false;
  }
}

/** Get headers with session ID for daemon routing */
export function sessionHeaders(forSessionId?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // The explicit owner override applies unconditionally — it doesn't depend
  // on the window-injected connection store.
  if (forSessionId) headers["X-Session-Id"] = forSessionId;
  if (typeof window === "undefined") return headers;
  try {
    const connState = (window as any).__dpConnectionStore?.getState?.();
    // F6 — mutations on MERGED artifacts must route to the session that OWNS
    // the artifact, not the tab's bound session: routing by the tab silently
    // no-op'd (or worse, mis-stored comments) on every cross-session write.
    // Callers pass the artifact's own sessionId; absent, the tab's binding
    // applies as before.
    const sid = forSessionId ?? connState?.sessionId;
    if (sid) {
      headers["X-Session-Id"] = sid;
    }
    // Bug A — when the caller passes an EXPLICIT owner this daemon does NOT
    // serve, do NOT stamp the current daemon's projectHash/bearer token: they'd
    // guarantee a project_hash_mismatch / unknown-session 409 and mislead the
    // user into thinking the write could land. The store-level guard already
    // refuses the POST; this is defense in depth (and keeps us from ever
    // sending one daemon's creds paired with another daemon's session id).
    if (forSessionId && isForeignSession(forSessionId)) {
      return headers;
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
    throw new ApiError(0, "network_error", `Couldn't reach the daemon. Run \`node packages/mcp-server/dist/cli/init.js doctor\` to diagnose.`);
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
    message = "No active deepPairing session. Start Claude Code with deepPairing configured, or run `node packages/mcp-server/dist/cli/init.js doctor --fix`.";
  }

  throw new ApiError(res.status, code, message);
}
