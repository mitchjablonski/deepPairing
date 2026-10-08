import { useEffect } from "react";

/**
 * #487 review — composers whose text lives only in React state (not useDraft)
 * register it here, so the one Reload this app offers (the "still loading"
 * state) can warn before discarding it. useDraft-backed composers survive a
 * reload on their own and don't need this.
 */
const sources = new Map<string, string>();

export function useUnsavedText(key: string, text: string): void {
  useEffect(() => {
    if (text.trim()) sources.set(key, text);
    else sources.delete(key);
    return () => { sources.delete(key); };
  }, [key, text]);
}

export function hasUnsavedText(): boolean {
  return [...sources.values()].some((t) => t.trim().length > 0);
}
