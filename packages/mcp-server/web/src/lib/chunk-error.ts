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
 * vite:preloadError handler — auto-recover ONCE per window by reloading (the
 * fresh index.html references the new chunk hashes). Loop-guarded via
 * sessionStorage timestamp; on a second failure inside the window we let the
 * error propagate so the chunk-aware ErrorBoundary shows the reload CTA.
 * `reload` is injectable for tests.
 */
export function handlePreloadError(
  e: { preventDefault: () => void },
  reload: () => void = () => window.location.reload(),
): void {
  let last = 0;
  try { last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0; } catch { /* no storage */ }
  if (Date.now() - last < RELOAD_MIN_INTERVAL_MS) return; // let it propagate to the boundary
  try { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); } catch { /* best-effort */ }
  e.preventDefault();
  reload();
}

export function installPreloadErrorRecovery(): void {
  window.addEventListener("vite:preloadError", (e) => handlePreloadError(e));
}
