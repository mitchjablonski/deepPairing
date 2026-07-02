import { useEffect, useRef, useState } from "react";

/**
 * D9 (H5) — composer draft persistence. Plain useState drafts died with the
 * tab: ordinary reloads and the stale-daemon "Reload to re-bind" toasts
 * destroyed exactly the long-form feedback the product exists to collect.
 * sessionStorage (the rail's existing idiom) survives reloads but not new
 * tabs — the right scope for a draft.
 *
 * Keys are namespaced per surface AND per session/artifact/decision, so a
 * draft typed against session A can never surface (or send) in session B —
 * which also retires the wrong-session-send footgun (M5) without clearing
 * anything: switch away, the other session's own (empty) draft loads; switch
 * back, yours is still there.
 */
export function useDraft(key: string): [string, (v: string) => void] {
  const storageKey = `dp:draft:${key}`;
  const [value, setValue] = useState<string>(() => {
    try { return sessionStorage.getItem(storageKey) ?? ""; } catch { return ""; }
  });

  // Re-key: when the key changes (session/artifact switch), load THAT draft.
  const prevKey = useRef(storageKey);
  useEffect(() => {
    if (prevKey.current === storageKey) return;
    prevKey.current = storageKey;
    try { setValue(sessionStorage.getItem(storageKey) ?? ""); } catch { setValue(""); }
  }, [storageKey]);

  // Debounced write; empty value deletes the entry (send/clear = cleanup).
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (value) sessionStorage.setItem(storageKey, value);
        else sessionStorage.removeItem(storageKey);
      } catch { /* quota/denied — draft just won't persist */ }
    }, 300);
    return () => clearTimeout(t);
  }, [value, storageKey]);

  return [value, setValue];
}
