import { create } from "zustand";

/**
 * #470 (§3a) — which block's "Allow once" dialog is open. One dialog for the
 * app, opened from the hero toast or a gate-log entry; it returns focus to the
 * button that opened it, and the toast that opened it holds its auto-dismiss
 * while it is open.
 */
export interface AllowOnceRequest {
  blockId: string;
  concept: string;
  /** The opener, to refocus on close (§3a "Focus"). */
  returnFocusTo?: HTMLElement | null;
  /** The toast that opened it, if any (its auto-dismiss pauses). */
  toastId?: string;
}

interface AllowOnceState {
  request: AllowOnceRequest | null;
  open: (r: AllowOnceRequest) => void;
  close: () => void;
}

export const useAllowOnceStore = create<AllowOnceState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
