import { create } from "zustand";
import { apiBase, apiGet } from "../lib/api";

/**
 * X7 — hook fire history surfaced to the companion UI.
 *
 * Hook scripts (.deeppairing/hooks/stop.mjs and checkpoint.mjs) append
 * every fire (pass OR nag) to .deeppairing/hooks-state.json. The daemon
 * watches that file and broadcasts a `hook_fired` event for each new
 * entry. This store keeps the latest fires in memory so HookStatus can
 * render without an HTTP roundtrip per fire.
 */

export interface HookFire {
  at: string;        // ISO timestamp
  hook: "stop" | "checkpoint" | string;
  exitCode: number;
  reason: string;
}

interface HookStatusState {
  fires: HookFire[];
  loaded: boolean;
  /** Initial load via /api/hook-state — call once on mount. */
  load: () => Promise<void>;
  /** Merge a single fire from a `hook_fired` broadcast event. */
  pushFire: (fire: HookFire) => void;
  reset: () => void;
}

const MAX_FIRES_KEPT = 25;

export const useHookStatusStore = create<HookStatusState>((set, get) => ({
  fires: [],
  loaded: false,

  load: async () => {
    try {
      const res = await apiGet(`${apiBase()}/api/hook-state`);
      if (!res.ok) {
        set({ loaded: true });
        return;
      }
      const body = await res.json();
      const fires: HookFire[] = Array.isArray(body?.fires) ? body.fires : [];
      // Sort newest-first for display.
      const sorted = [...fires].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_FIRES_KEPT);
      set({ fires: sorted, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  pushFire: (fire) => {
    if (!fire || typeof fire.at !== "string") return;
    const { fires } = get();
    // Dedupe by (at + hook) — same fire could broadcast twice if
    // multiple sessions are open and the daemon fans out per-session.
    if (fires.some((f) => f.at === fire.at && f.hook === fire.hook)) return;
    const next = [fire, ...fires].slice(0, MAX_FIRES_KEPT);
    set({ fires: next });
  },

  reset: () => set({ fires: [], loaded: false }),
}));
