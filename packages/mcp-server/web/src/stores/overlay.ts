import { useEffect } from "react";
import { create } from "zustand";

/**
 * UX4 — app-level "is a modal/overlay present?" signal. The global keyboard
 * shortcuts (App.tsx) must suppress the artifact actions (j/k/a/r/q) whenever
 * something is rendered over the artifact, else e.g. `a` arms an approve on the
 * artifact hidden behind the modal. App-owned overlays are tracked by their
 * boolean state; component-internal modals (FileViewer, RepairDecisionModal,
 * HookStatus) that App can't see register here via useOverlayPresence().
 */
interface OverlayState {
  count: number;
  inc: () => void;
  dec: () => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  count: 0,
  inc: () => set((s) => ({ count: s.count + 1 })),
  dec: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
}));

/** Mark an overlay as present while `active` (default true, for components that
 *  only mount when shown; pass a flag for always-mounted ones like HookStatus). */
export function useOverlayPresence(active = true): void {
  const inc = useOverlayStore((s) => s.inc);
  const dec = useOverlayStore((s) => s.dec);
  useEffect(() => {
    if (!active) return;
    inc();
    return () => dec();
  }, [active, inc, dec]);
}
