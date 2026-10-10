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

export type ToastKind = "info" | "success" | "block" | "error" | "preflight-block";

/**
 * Rich data for a preflight-block toast — the moment deepPairing refuses to
 * let the agent re-propose something the human already rejected. Kept here
 * rather than flattened into the generic title/body so the toast component
 * can render it as a hero card instead of a line of text.
 */
export interface PreflightBlockHero {
  source: "session" | "team";
  concept: string;
  /** Raw rejected-approach description — carried alongside `concept` so an
   *  override can identify the exact personal stance to scope down. */
  description?: string;
  proposal?: string;
  reason?: string;
  via: "surface" | "concept" | "avoid" | "require";
  addedBy?: string;
  rejectedAt?: string;
  projectCount?: number;
  /** #470 — the durable block-log id, so the toast can act on THIS block. */
  blockId?: string;
  /** #470 — whether the daemon says this block can be allowed once. */
  eligible?: boolean;
  ineligibleReason?: string;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /** Rich payload for kind: "preflight-block". Ignored for other kinds. */
  hero?: PreflightBlockHero;
  /**
   * R2 — override the kind's default glyph with one of the app's inline SVG
   * marks. Named rather than a ReactNode so this store (and the connection
   * store that pushes most toasts) stays JSX-free; ToastLayer resolves the
   * name. Exists because the ledger toasts shipped a literal 🧭 in their TITLE
   * STRING, which renders as tofu wherever a colour-emoji font is missing —
   * the same defect Q4 fixed for the preflight hero's 🛡.
   */
  icon?: "compass" | "shield";
  /** #470 — render without a live-region role: the words were already spoken
   *  by the one announcer (NextUpBar), so the toast must not say them twice. */
  quiet?: boolean;
  /** #470 — a CLI grant gets the stronger style (§3 "Detection reaches the human"). */
  strong?: boolean;
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
  /** #470 (§3a) — hold a toast's auto-dismiss while it has hover/focus or
   *  its dialog is open; resume restarts the remaining time. Counted, so two
   *  holders (hover + dialog) both have to let go. */
  pause: (id: string) => void;
  resume: (id: string) => void;
}

const timers = new Map<string, { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number; holds: number }>();

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
      timers.set(id, { handle: setTimeout(() => get().dismiss(id), toast.ttl), remaining: toast.ttl, startedAt: Date.now(), holds: 0 });
    }
    return id;
  },

  dismiss: (id) => {
    const t = timers.get(id);
    if (t?.handle) clearTimeout(t.handle);
    timers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  dismissAll: () => {
    for (const t of timers.values()) if (t.handle) clearTimeout(t.handle);
    timers.clear();
    set({ toasts: [] });
  },

  pause: (id) => {
    const t = timers.get(id);
    if (!t) return;
    t.holds++;
    if (t.handle) {
      clearTimeout(t.handle);
      t.handle = null;
      t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
    }
  },

  resume: (id) => {
    const t = timers.get(id);
    if (!t) return;
    t.holds = Math.max(0, t.holds - 1);
    if (t.holds > 0 || t.handle) return;
    t.startedAt = Date.now();
    // Never vanish the instant a reader lets go.
    t.handle = setTimeout(() => get().dismiss(id), Math.max(t.remaining, 2000));
  },
}));
