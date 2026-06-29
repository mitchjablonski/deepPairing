import { useEffect, useRef } from "react";

/**
 * PP3 — poll on an interval, but ONLY while the tab is visible (and `enabled`).
 * The companion app had 2-3 REST polls firing every ~5s forever, each a fetch +
 * JSON parse + a store set that re-renders. This pauses the timer on
 * `document.hidden` and resumes (with an immediate catch-up call) on re-show, so
 * a backgrounded tab does no polling work. Pass `enabled` to also stop entirely
 * in a given state (e.g. App gates its session poll on `connected`); note that
 * cross-project discovery pollers intentionally keep running while disconnected.
 */
export function usePollingWhenVisible(
  callback: () => void,
  intervalMs: number,
  enabled = true,
): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer == null) timer = setInterval(() => cbRef.current(), intervalMs);
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        cbRef.current(); // catch up immediately on re-show
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);
}
