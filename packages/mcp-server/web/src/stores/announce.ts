import { create } from "zustand";

/**
 * #470 (§3a) — the text the ONE polite announcer (NextUpBar's
 * `next-up-announcer`) speaks for stance-exception moments: a grant, the
 * change from allowed to used, and a change to "changed". There is no second
 * live region: this store only carries words; NextUpBar renders them.
 */
interface AnnounceState {
  message: string;
  seq: number;
  announce: (message: string) => void;
}

export const useAnnounceStore = create<AnnounceState>((set) => ({
  message: "",
  seq: 0,
  announce: (message) => set((s) => ({ message, seq: s.seq + 1 })),
}));

export function announce(message: string): void {
  useAnnounceStore.getState().announce(message);
}
