import { useEffect, useMemo, useState } from "react";
import { coercePageContent, type Artifact, type PageAskRef } from "@deeppairing/shared";
import { peekVersionAsks, versionAsks } from "../lib/pageAskVersions";

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (h: number) => void;
};

/**
 * #714 gap 5 — the asks of the given page versions (the current one and the
 * earlier ones earlier-version comments point at), parsed from their HTML
 * OFF the render path: cached versions are returned at once, the rest are
 * parsed in an idle callback (as #718's diff is) and land in a re-render.
 * `get(id)` is undefined until a version is parsed; callers treat that as
 * "not yet counted" (an earlier answer doesn't carry until then).
 */
export interface PageAskVersions {
  /** A version's asks; undefined until it is parsed (null parses count as parsed, with no asks). */
  get: (artifactId: string) => PageAskRef[] | undefined;
  /** #727 — some requested version hasn't been parsed yet. */
  pending: boolean;
}

export function usePageAskVersions(versions: readonly Artifact[], enabled: boolean): PageAskVersions {
  const key = enabled ? versions.map((v) => v.id).join("\u0000") : "";
  const [tick, setTick] = useState(0);
  // Which requested versions aren't in the cache NOW: also re-requests a
  // version the shared LRU evicted while this page is mounted. A version
  // whose HTML didn't parse is cached as null — parsed, never retried.
  const missingKey = key
    ? versions.filter((v) => peekVersionAsks(v.id) === undefined).map((v) => v.id).join("\u0000")
    : "";
  useEffect(() => {
    if (!missingKey) return;
    const missing = versions.filter((v) => peekVersionAsks(v.id) === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      for (const v of missing) versionAsks(v.id, coercePageContent(v.content).html);
      if (!cancelled) setTick((t) => t + 1);
    };
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === "function") {
      const h = w.requestIdleCallback(run, { timeout: 400 });
      return () => {
        cancelled = true;
        w.cancelIdleCallback?.(h);
      };
    }
    const t = setTimeout(run, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `versions` is captured through `missingKey` (their ids); a version's HTML never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);
  return useMemo(() => {
    void tick;
    const ids = new Set(key ? key.split("\u0000") : []);
    return {
      get: (artifactId: string) => (ids.has(artifactId) ? peekVersionAsks(artifactId) ?? undefined : undefined),
      pending: missingKey !== "",
    };
  }, [key, tick, missingKey]);
}
