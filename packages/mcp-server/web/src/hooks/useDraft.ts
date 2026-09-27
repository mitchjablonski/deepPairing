import { useEffect, useRef, useState, useSyncExternalStore } from "react";

function writeDraft(key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch { /* quota/denied — draft just won't persist */ }
}

const DRAFT_SENT_EVENT = "dp:draft-sent";

/**
 * #417 review — "a send of THIS draft is in flight", keyed by draft key and
 * held OUTSIDE any component. A per-instance ref guard reset whenever the
 * composer remounted mid-send (a reconnect can unmount it), so the new
 * instance offered Send again and a second click posted twice. Module-level,
 * the marker outlives the instance; the sender releases it in `finally`, so a
 * failed or rejected send can't wedge it.
 */
const sendingKeys = new Set<string>();
const sendingListeners = new Set<() => void>();
const notifySending = () => { for (const l of sendingListeners) l(); };
export function isDraftSending(key: string): boolean {
  return sendingKeys.has(key);
}
/** Mark `key` as sending; returns an idempotent release. */
export function markDraftSending(key: string): () => void {
  sendingKeys.add(key);
  notifySending();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sendingKeys.delete(key);
    notifySending();
  };
}
const subscribeSending = (cb: () => void) => {
  sendingListeners.add(cb);
  return () => { sendingListeners.delete(cb); };
};
/** Re-renders when a send of `key` starts or settles, from any instance. */
export function useDraftSending(key: string): boolean {
  return useSyncExternalStore(subscribeSending, () => sendingKeys.has(key), () => false);
}

/**
 * #417 — compare-and-delete a PERSISTED draft. For a send that completes after
 * its composer moved on (session switch, unmount): the submitted text is gone
 * from the server's point of view, so its saved draft must not resurrect when
 * you come back — but only if it is still exactly what was sent, never text
 * written after it.
 */
export function clearDraftIfUnchanged(key: string, sent: string): void {
  const storageKey = `dp:draft:${key}`;
  try {
    if (sessionStorage.getItem(storageKey) === sent) sessionStorage.removeItem(storageKey);
  } catch { /* storage denied — nothing persisted to clear */ }
  // A composer that REMOUNTED on this same key (a reconnect can unmount the
  // composer mid-send) already loaded the sent text into its state; tell it.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DRAFT_SENT_EVENT, { detail: { storageKey, sent } }));
  }
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

  // #417 — a send that settled elsewhere (see clearDraftIfUnchanged) retires
  // this draft only if it is on the same key and still exactly the sent text.
  useEffect(() => {
    const onSent = (e: Event) => {
      const { storageKey: k, sent } = (e as CustomEvent<{ storageKey: string; sent: string }>).detail;
      if (k === latest.current.key && latest.current.value === sent) setValue("");
    };
    window.addEventListener(DRAFT_SENT_EVENT, onSent);
    return () => window.removeEventListener(DRAFT_SENT_EVENT, onSent);
  }, []);

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
