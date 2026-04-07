import { useState, useEffect } from "react";
import { highlightLines } from "../lib/highlighter";
import { usePreferencesStore } from "../stores/preferences";

// Simple LRU cache
const cache = new Map<string, string[]>();
const MAX_CACHE = 100;

function cacheKey(code: string, lang: string, theme: string): string {
  return `${theme}:${lang}:${code.slice(0, 200)}:${code.length}`;
}

/**
 * React hook for syntax-highlighted code lines.
 * Returns an array of HTML strings (one per line), or null while loading.
 */
export function useHighlightedCode(
  code: string,
  language: string,
): { lines: string[] | null; loading: boolean } {
  const [lines, setLines] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const theme = usePreferencesStore((s) => s.theme);
  const shikiTheme = theme === "light" ? "vitesse-light" : "vitesse-dark";

  useEffect(() => {
    if (!code) {
      setLines([]);
      setLoading(false);
      return;
    }

    const key = cacheKey(code, language, shikiTheme);
    const cached = cache.get(key);
    if (cached) {
      setLines(cached);
      setLoading(false);
      return;
    }

    setLoading(true);
    let cancelled = false;

    highlightLines(code, language, shikiTheme).then((result) => {
      if (cancelled) return;

      // Cache with LRU eviction
      if (cache.size >= MAX_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(key, result);

      setLines(result);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [code, language, shikiTheme]);

  return { lines, loading };
}
