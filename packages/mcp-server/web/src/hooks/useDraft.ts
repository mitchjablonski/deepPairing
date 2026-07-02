import { useEffect, useRef, useState } from "react";

function writeDraft(key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch { /* quota/denied — draft just won't persist */ }
}

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

  // D9 review — the debounce needs a FLUSH: canceling the pending write on
  // key switch / unmount / reload lost everything typed in the last 300ms —
  // and the reload toast is this feature's headline case. Latest value rides
  // a ref; cleanups flush it under the key it was typed against.
  const latest = useRef({ key: storageKey, value });
  latest.current.value = value;

  // Re-key: flush the OLD key's draft, then load the new key's.
  const prevKey = useRef(storageKey);
  useEffect(() => {
    if (prevKey.current === storageKey) return;
    writeDraft(prevKey.current, latest.current.value);
    prevKey.current = storageKey;
    latest.current = { key: storageKey, value: "" };
    try { setValue(sessionStorage.getItem(storageKey) ?? ""); } catch { setValue(""); }
  }, [storageKey]);
  latest.current.key = prevKey.current;

  // Debounced write; empty value deletes the entry (send/clear = cleanup).
  useEffect(() => {
    const t = setTimeout(() => writeDraft(storageKey, value), 300);
    return () => clearTimeout(t);
  }, [value, storageKey]);

  // Flush on unmount and on reload/navigation (pagehide covers both).
  useEffect(() => {
    const flush = () => writeDraft(latest.current.key, latest.current.value);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  return [value, setValue];
}
