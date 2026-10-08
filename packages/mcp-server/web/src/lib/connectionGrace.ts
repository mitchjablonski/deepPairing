import { useEffect } from "react";
import { create } from "zustand";
import { useConnectionStore } from "../stores/connection";

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

interface GraceState {
  everConnected: boolean;
  graceOver: boolean;
}

export const useConnectionGraceStore = create<GraceState>(() => ({ everConnected: false, graceOver: false }));

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
}

/** True when this tab is offline (and it's not just the page loading). */
export function useTabOffline(): boolean {
  const connected = useConnectionStore((s) => s.connected);
  const past = useConnectionGraceStore((s) => s.everConnected || s.graceOver);
  return !connected && past;
}
