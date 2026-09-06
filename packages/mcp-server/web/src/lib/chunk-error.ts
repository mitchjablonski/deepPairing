/**
 * E5 — deploy/chunk-skew detection (field-confirmed via the crawler handoff).
 *
 * A tab opened before a rebuild holds the old index.html; the first artifact
 * that needs a re-hashed lazy chunk (the D6 boundary) fails its dynamic
 * import, and the per-artifact ErrorBoundary used to mislabel that as
 * "content may be malformed" — blaming the artifact when the render
 * ENVIRONMENT was stale. Hard-refresh fixed it in the field.
 */

/** The browser/vite messages a failed dynamic import surfaces as. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i.test(msg);
}

const RELOAD_GUARD_KEY = "dp:preload-reload-at";
/** Allow another auto-reload only after this long — breaks reload loops when
 *  the server genuinely can't serve the chunk (daemon down mid-deploy). */
const RELOAD_MIN_INTERVAL_MS = 30_000;

/**
 * #339 — is the daemon (the only origin that can serve a chunk) reachable?
 * Read off the window-exposed connection store (the same bridge lib/api.ts
 * uses, no import edge into the stores). "Unreachable" means the tab HAD a
 * live socket and lost it (`disconnectedSince` is stamped on the first drop of
 * an outage); a tab that has never connected keeps the plain skew policy, so
 * bootstrap behaviour is unchanged. Unknown store → assume reachable.
 */
export function daemonReachable(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const s = (window as unknown as {
      __dpConnectionStore?: { getState?: () => { connected?: boolean; disconnectedSince?: number | null } };
    }).__dpConnectionStore?.getState?.();
    if (!s) return true;
    return !(s.connected === false && s.disconnectedSince != null);
  } catch {
    return true;
  }
}

/**
 * #339 — a chunk failed while the daemon was unreachable. Armed by
 * handlePreloadError, consumed by reloadIfChunkFailedOffline on the next
 * successful connect. Module-scoped (not sessionStorage): it describes THIS
 * document's poisoned module map, which a reload replaces.
 */
let reloadDeferredUntilReachable = false;

/** For the chunk-aware ErrorBoundary copy: is the failure an outage, not skew? */
export function isReloadDeferredForOutage(): boolean {
  return reloadDeferredUntilReachable;
}

function reloadGuardOpen(): boolean {
  let last = 0;
  try { last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0; } catch { /* no storage */ }
  return Date.now() - last >= RELOAD_MIN_INTERVAL_MS;
}

function stampReloadGuard(): void {
  try { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); } catch { /* best-effort */ }
}

/**
 * vite:preloadError handler — auto-recover ONCE per window by reloading (the
 * fresh index.html references the new chunk hashes). Loop-guarded via
 * sessionStorage timestamp; on a second failure inside the window we let the
 * error propagate so the chunk-aware ErrorBoundary shows the reload CTA.
 * `reload` / `reachable` are injectable for tests.
 *
 * #339 — when the daemon is UNREACHABLE the failure is an outage, not skew,
 * and a reload can only land on the browser's error page: the tab, its valid
 * frame, replay's read-only lock and every recovery affordance would be gone
 * (observed in a real Chromium tab, e2e/recovery.e2e.ts). So: never reload
 * toward an origin that cannot answer. Let the error propagate — the caller's
 * catch / the boundary keep the current view — and arm ONE deferred reload
 * that fires from the connection store's next successful connect, when the
 * origin can serve the fresh code again. The 30s loop guard applies to that
 * deferred reload exactly as to an immediate one.
 */
export function handlePreloadError(
  e: { preventDefault: () => void },
  reload: () => void = () => window.location.reload(),
  reachable: () => boolean = daemonReachable,
): void {
  if (!reachable()) {
    reloadDeferredUntilReachable = true;
    return; // propagate: the view keeps what it has, the boundary explains
  }
  if (!reloadGuardOpen()) return; // let it propagate to the boundary
  stampReloadGuard();
  e.preventDefault();
  reload();
}

/**
 * #339 — the bounded recovery for a chunk that failed during an outage. Called
 * by the connection store on every successful connect; a no-op unless a
 * failure was deferred. Returns whether a reload was issued.
 */
export function reloadIfChunkFailedOffline(
  reload: () => void = () => window.location.reload(),
): boolean {
  if (!reloadDeferredUntilReachable) return false;
  reloadDeferredUntilReachable = false;
  if (!reloadGuardOpen()) return false;
  stampReloadGuard();
  reload();
  return true;
}

/** Test seam: forget a deferred reload between cases. */
export function resetDeferredReloadForTests(): void {
  reloadDeferredUntilReachable = false;
}

export function installPreloadErrorRecovery(): void {
  window.addEventListener("vite:preloadError", (e) => handlePreloadError(e));
}
