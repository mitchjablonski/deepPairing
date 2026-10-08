import { useEffect } from "react";
import { create } from "zustand";
import { useConnectionStore, selectHydratedForBinding } from "../stores/connection";
import { hasUnsavedText } from "./unsavedText";

/**
 * #465 N2 / #467 review — ONE answer to "is this tab offline?", shared by the
 * disconnect banner, the Next-up bar's DISCONNECTED prefix and every act
 * button. A page load is not an outage: until the tab has connected once, it
 * waits out a short grace (so a daemon that is really down at load still
 * shows). After that, `connected === false` is offline — for ANY reason,
 * including a fatal stale-daemon mismatch, which sets connected:false without
 * a disconnectedSince stamp.
 *
 * Global (not per-component) so a component mounted mid-outage doesn't get a
 * fresh grace of its own. App drives it once (useConnectionGraceDriver).
 */
export const FIRST_CONNECT_GRACE_MS = 3000;

/**
 * #477 (D8 edge) — a CONNECTED tab whose first snapshot never applies (and no
 * refusal arrives) would otherwise sit at hydrated:false forever: the bar says
 * "Checking what needs you…" indefinitely and TurnIndicator stays silent.
 * Past this bound the UI says so truthfully, with Reload. 10s: a normal
 * hydration is one localhost snapshot frame — ~100–300ms in the walkthrough
 * timings (the real line at t≈255ms), a second or two for a very large session
 * on a slow disk — so 10s is well over an order of magnitude above normal, yet
 * short enough that a person isn't left guessing. A late hydration clears it.
 */
export const HYDRATION_STALL_MS = 10_000;

interface GraceState {
  everConnected: boolean;
  graceOver: boolean;
  /** #477 — connected, but the first snapshot hasn't applied in HYDRATION_STALL_MS. */
  hydrationStalled: boolean;
}

export const useConnectionGraceStore = create<GraceState>(() => ({ everConnected: false, graceOver: false, hydrationStalled: false }));

/** Mounted once, by App. */
export function useConnectionGraceDriver(): void {
  const connected = useConnectionStore((s) => s.connected);
  useEffect(() => {
    if (connected && !useConnectionGraceStore.getState().everConnected) {
      useConnectionGraceStore.setState({ everConnected: true });
    }
  }, [connected]);
  useEffect(() => {
    const t = setTimeout(() => useConnectionGraceStore.setState({ graceOver: true }), FIRST_CONNECT_GRACE_MS);
    return () => clearTimeout(t);
  }, []);
  // #477 — the hydration watchdog: armed while connected-but-not-hydrated;
  // a hydration (however late) or a disconnect clears it.
  // #487 review (Sol P2) — evidence for the CURRENT binding only: a switch to
  // another session/project re-arms the deadline instead of inheriting the
  // previous binding's applied snapshot.
  const hydrated = useConnectionStore(selectHydratedForBinding);
  useEffect(() => {
    if (!connected || hydrated) {
      if (useConnectionGraceStore.getState().hydrationStalled) useConnectionGraceStore.setState({ hydrationStalled: false });
      return;
    }
    const t = setTimeout(() => useConnectionGraceStore.setState({ hydrationStalled: true }), HYDRATION_STALL_MS);
    return () => clearTimeout(t);
  }, [connected, hydrated]);
}

/** #477 — true when the tab is connected but its first snapshot never applied. */
export function useHydrationStalled(): boolean {
  return useConnectionGraceStore((s) => s.hydrationStalled);
}

/** #487 review (Fable) — ONE wording for the bar, the banner and the main
 *  area. Honest: loading may still finish; Reload is an offer. The 10s bound
 *  stays (the snapshot's size isn't known before it arrives). */
export const HYDRATION_STALLED_TEXT =
  "Still loading this session — it's taking longer than usual. It may still finish.";
/** The full sentence, for a context WITHOUT a Reload button next to it (every
 *  current surface has one, so the short form above is what renders — no
 *  "…reload. Reload"). */
export const HYDRATION_STALLED_SENTENCE =
  "Still loading this session — it's taking longer than usual. It may still finish, or you can reload.";
export const RELOAD_TITLE = "Reload the page — saved drafts are kept";
/** The bar announcer's one-time line when the stall begins. */
export const HYDRATION_STALLED_ANNOUNCEMENT = "Still loading this session — Reload is available";

/**
 * #487 review (Fable) — Reload asks first when a composer holds unsent text,
 * through the app's own modal (ReloadConfirmDialog: Keep is the default and
 * focused choice, Esc keeps) — not window.confirm, where Enter discards.
 */
export const useReloadConfirmStore = create<{ open: boolean }>(() => ({ open: false }));
export function reloadNow(): void {
  if (typeof window !== "undefined") window.location.reload();
}
export function reloadPage(): void {
  if (typeof window === "undefined") return;
  if (hasUnsavedText()) {
    useReloadConfirmStore.setState({ open: true });
    return;
  }
  reloadNow();
}

/** True when this tab is offline (and it's not just the page loading). */
export function useTabOffline(): boolean {
  const connected = useConnectionStore((s) => s.connected);
  const past = useConnectionGraceStore((s) => s.everConnected || s.graceOver);
  return !connected && past;
}
