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
 * #339 — the recovery state machine for a failed chunk, observable by the
 * chunk-aware ErrorBoundary so its copy tells the truth about what happens
 * next.
 *   idle      nothing pending
 *   probing   a chunk failed; asking the ASSET ORIGIN whether it can answer
 *   deferred  the origin could not answer (failed or hung): ONE reload is
 *             armed for the next successful connect
 *   blocked   the origin answered but the loop guard refused a second
 *             reload inside its window: the manual Reload is the door
 */
export type ChunkRecoveryStatus = "idle" | "probing" | "deferred" | "blocked";
let chunkRecoveryStatus: ChunkRecoveryStatus = "idle";
let probeGeneration = 0;
let recheckAfterProbe = false;
const statusListeners = new Set<() => void>();

function setChunkRecoveryStatus(next: ChunkRecoveryStatus): void {
  if (chunkRecoveryStatus === next) return;
  chunkRecoveryStatus = next;
  for (const listener of statusListeners) listener();
}

export function getChunkRecoveryStatus(): ChunkRecoveryStatus {
  return chunkRecoveryStatus;
}

/** Subscribe to status changes (the boundary re-renders its copy). */
export function subscribeChunkRecovery(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

/** For the chunk-aware ErrorBoundary copy: is the failure an outage, not skew? */
export function isReloadDeferredForOutage(): boolean {
  return chunkRecoveryStatus === "deferred";
}

/** Bound on the reachability probe: a hung origin counts as unreachable. */
export const ASSET_ORIGIN_PROBE_TIMEOUT_MS = 2_000;

/**
 * #339 — ask the ASSET ORIGIN itself, right now, whether it can answer.
 * Cached transport state is not evidence: a WebSocket's close callback can be
 * delivered AFTER the chunk fetch that the same outage failed, so `connected`
 * may still read true while nothing is listening (Astra's ordering probe).
 * Any HTTP response — even a 404 or 500 — proves the origin is up (a failed
 * chunk on a live origin is skew); a network error or the bounded timeout
 * proves it is not. `/api/daemon-info` is the public, unauthenticated read
 * the daemon serves alongside the assets.
 */
export async function probeAssetOrigin(timeoutMs = ASSET_ORIGIN_PROBE_TIMEOUT_MS): Promise<boolean> {
  if (typeof window === "undefined" || typeof fetch !== "function") return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { resolve(false); controller.abort(); }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(`${window.location.origin}/api/daemon-info`, {
        cache: "no-store", signal: controller.signal, redirect: "error", credentials: "omit",
      }).then(() => true, () => false),
      deadline,
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function reloadGuardOpen(): boolean {
  let last = 0;
  try { last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0; } catch { /* no storage */ }
  return Date.now() - last >= RELOAD_MIN_INTERVAL_MS;
}

function stampReloadGuard(): void {
  try { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); } catch { /* best-effort */ }
}

interface PreloadErrorDeps {
  reload?: () => void;
  /** Resolves true when the asset origin answers; false on error or timeout. */
  probe?: () => Promise<boolean>;
}

/**
 * vite:preloadError handler — E5 chunk-skew recovery: a tab holding an old
 * index.html fails to fetch a re-hashed chunk; the fix is ONE reload (the
 * fresh index.html references the new hashes), loop-guarded via a
 * sessionStorage timestamp so a server that genuinely cannot serve the chunk
 * never reloads in a loop.
 *
 * #339 — the same event fires when the DAEMON IS GONE, and a reload toward an
 * origin that cannot answer lands on the browser's error page: the document,
 * its valid frame, replay's read-only lock and every recovery affordance are
 * lost (observed in a real Chromium tab, e2e/recovery.e2e.ts). The handler
 * therefore never reloads on the event itself and never consults cached
 * transport state; it lets the error propagate (the caller's catch or the
 * chunk-aware boundary keep the current view — no preventDefault, which
 * would make vite resolve the import as undefined and hide the chunk error
 * behind a TypeError) and asks the origin, bounded:
 *   answers → skew: reload now, once per guard window (else "blocked", the
 *             boundary's manual Reload is the door);
 *   fails or hangs → outage: arm ONE reload for the next successful connect
 *             (reloadIfChunkFailedOffline), same guard.
 * Both event orders — close delivered before the failed chunk, or after —
 * take this one path, because the decision comes from the probe, not the
 * store. `reload` / `probe` are injectable for tests.
 */
export function handlePreloadError(
  _e: { preventDefault: () => void },
  deps: PreloadErrorDeps = {},
): void {
  if (chunkRecoveryStatus === "probing" || chunkRecoveryStatus === "deferred") return; // already handled
  startAssetOriginRecovery(deps);
}

function startAssetOriginRecovery(deps: PreloadErrorDeps): void {
  const generation = ++probeGeneration;
  const reload = deps.reload ?? (() => window.location.reload());
  const probe = deps.probe ?? (() => probeAssetOrigin());
  setChunkRecoveryStatus("probing");
  void Promise.resolve()
    .then(probe)
    .catch(() => false)
    .then((reachable) => {
      if (generation !== probeGeneration) return;
      const recheck = recheckAfterProbe;
      recheckAfterProbe = false;
      if (!reachable) {
        setChunkRecoveryStatus("deferred");
        // A reconnect that raced this failed request is a reason to ask again,
        // not evidence that the origin serving this document is available.
        if (recheck) startAssetOriginRecovery(deps);
        return;
      }
      if (!reloadGuardOpen()) {
        setChunkRecoveryStatus("blocked");
        return;
      }
      stampReloadGuard();
      setChunkRecoveryStatus("idle");
      reload();
    });
}

/**
 * #339 — the bounded recovery for a chunk that failed during an outage.
 * A successful API connection only triggers another ASSET-origin check: the
 * selected daemon may be on another origin. Never skip normal connection
 * setup or hydration while that asynchronous check runs.
 */
export function reloadIfChunkFailedOffline(
  deps: PreloadErrorDeps = {},
): void {
  if (chunkRecoveryStatus === "probing") {
    recheckAfterProbe = true;
    return;
  }
  if (chunkRecoveryStatus === "deferred") startAssetOriginRecovery(deps);
}

/** Test seam: forget any pending recovery between cases. */
export function resetDeferredReloadForTests(): void {
  chunkRecoveryStatus = "idle";
  probeGeneration++;
  recheckAfterProbe = false;
}

export function installPreloadErrorRecovery(): void {
  window.addEventListener("vite:preloadError", (e) => handlePreloadError(e));
}
