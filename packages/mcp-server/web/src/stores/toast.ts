import { create } from "zustand";

/**
 * Ephemeral toast messages — non-blocking notifications that surface moments
 * the user wouldn't otherwise see. Kept deliberately minimal: one active
 * queue, auto-dismiss, manual dismiss.
 *
 * The main consumer is the pre-flight-block event: when deepPairing refuses
 * an agent proposal that matches a prior rejection, we toast the user so the
 * invisible moat becomes a felt one.
 */

export type ToastKind = "info" | "success" | "block" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /** Milliseconds before auto-dismiss. 0 = sticky (user must dismiss). */
  ttl?: number;
  /** Optional action label + handler (e.g. "Open Memory"). */
  action?: { label: string; onClick: () => void };
  createdAt: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id" | "createdAt">) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const DEFAULT_TTL = 6000;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (t) => {
    const id = `tst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const toast: Toast = {
      id,
      createdAt: Date.now(),
      ttl: t.ttl ?? DEFAULT_TTL,
      ...t,
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    // Auto-dismiss unless the toast opted into being sticky.
    if (toast.ttl && toast.ttl > 0) {
      setTimeout(() => get().dismiss(id), toast.ttl);
    }
    return id;
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  dismissAll: () => set({ toasts: [] }),
}));
