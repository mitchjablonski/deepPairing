import { useEffect, useState } from "react";

/**
 * E7 — one-shot effect fetch with REAL cancellation. The `let cancelled`
 * pattern this replaces only ignored the result: the request itself stayed
 * in-flight after unmount, and anything that tears the window down mid-flight
 * (happy-dom test teardown — the N4 flake; tab close) aborted it noisily.
 * Tying an AbortController to the effect cleanup settles the request inside
 * our own catch instead.
 *
 * For interval/event-driven fetches, use the same primitive manually:
 * `const ac = new AbortController()` in the effect, pass `ac.signal` to
 * apiGet/fetch, `return () => ac.abort()`.
 */
export function useAbortableFetch<T>(
  fetcher: (signal: AbortSignal) => Promise<T | null>,
  deps: readonly unknown[],
): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      const result = await fetcher(ac.signal).catch(() => null);
      if (!ac.signal.aborted) setData(result);
    })();
    return () => ac.abort();
  }, deps); // caller-owned deps — the hook's contract (no exhaustive-deps plugin loaded)
  return data;
}
