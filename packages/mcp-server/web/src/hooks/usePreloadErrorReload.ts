import { useEffect, useRef } from "react";
import { useToastStore } from "../stores/toast";

/**
 * Mermaid resilience — when the daemon is rebuilt (new asset hashes) or
 * restarted, an already-open tab's lazy-loaded chunks (mermaid, etc.) 404 with
 * a cryptic "Failed to fetch dynamically imported module". Vite fires
 * `vite:preloadError` for exactly this; we surface a sticky reload prompt (once)
 * instead of letting the raw error surface. Mirrors the connection store's
 * "reload to re-bind" recovery for a stale daemon hash.
 */
export function usePreloadErrorReload(): void {
  const prompted = useRef(false);
  useEffect(() => {
    const onPreloadError = (e: Event) => {
      e.preventDefault(); // suppress Vite's default rethrow; we prompt instead
      if (prompted.current) return;
      prompted.current = true;
      useToastStore.getState().push({
        kind: "info",
        title: "A new version is available",
        body: "The companion UI was updated or the daemon restarted. Reload to get the latest.",
        ttl: 0, // sticky — the tab can't load new code until it reloads
        action: { label: "Reload", onClick: () => window.location.reload() },
      });
    };
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => window.removeEventListener("vite:preloadError", onPreloadError);
  }, []);
}
