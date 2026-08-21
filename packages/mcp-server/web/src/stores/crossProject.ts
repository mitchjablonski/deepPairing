import { create } from "zustand";
import { apiBase, apiGet, sessionHeaders } from "../lib/api";
import { useToastStore } from "./toast";

/**
 * Q2 — CROSS-PROJECT MEMORY, MADE REACHABLE.
 *
 * The failure this closes (round 12, HIGH): `globalLedgerPublish` defaults
 * FALSE, and the only thing that ever set it was the interactive `init` prompt
 * (cli/init.ts) or `deeppairing philosophy publish on|off`. The recommended
 * install path — the Claude Code plugin marketplace — runs neither. There was
 * no web UI control at all (grep = 0). So for the install we actually tell
 * people to use, the cross-project half of the product was structurally
 * unreachable, while the README (×3), the plugin card and the About text
 * claimed it unconditionally. A full reject-and-remember cycle left
 * `~/.deeppairing` non-existent.
 *
 * Two surfaces, one preference:
 *  1. The FIRST-REJECT CARD — offered once, immediately after the human's
 *     first "Reject & remember" in this project. That is the one moment the
 *     mechanic has just been taught (they literally just named a cross-project
 *     memory key), so it's the only moment where "want this on your other
 *     projects too?" is a question rather than an interruption.
 *  2. The AUTONOMY POPOVER toggle — the persistent, discoverable home, so the
 *     setting is still findable after "Not now".
 *
 * PRIVACY POSTURE UNCHANGED: default stays OFF, and both surfaces state
 * plainly what publishing means. The opt-in exists to stop a malicious
 * dependency in one project seeding stances the rest of your machine then
 * cites — see the FAQ. Reads from the global ledger are always on; this gates
 * WRITES only.
 */

const DISMISS_KEY = "dp.crossProjectCard.dismissed";

/** localStorage is unavailable in private modes / some jsdom configs — never throw. */
function readDismissed(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function writeDismissed(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // ignore
  }
}

interface CrossProjectState {
  /** null = not loaded yet (never render a state we haven't read from the server). */
  publish: boolean | null;
  /** Whether the one-time first-reject card is on screen right now. */
  cardVisible: boolean;
  /** True once the card has been shown-and-answered in this project. */
  dismissed: boolean;
  /** A save is in flight (both surfaces disable while it runs). */
  saving: boolean;

  /**
   * R2 — the measured height of the first-reject card while it is on screen
   * (0 when it isn't). ToastLayer lifts its column above this so the toast
   * stack and the consent card stop fighting over the bottom-right corner.
   */
  cardHeight: number;

  /** Seed from /api/state's `globalLedgerPublish` (or a `preference_changed` event). */
  hydratePublish: (value: boolean) => void;
  /**
   * R2 — COLD-PATH HYDRATION. Round 13 (cold-journey lens): `hydratePublish`
   * was only ever called from AutonomySlider's mount effect, and AutonomySlider
   * only mounts when the ⋯ diagnostics popover is OPENED. So on a cold page
   * load `publish` stayed `null` — and `noteStanceRecorded` bails on
   * `publish !== false`. The whole first-reject card was therefore unreachable
   * for anyone who rejected something before opening a menu they had no reason
   * to open, which is everyone on their first session.
   *
   * This action is the hydration the cold path needs: one GET, fail-soft (a
   * dead daemon leaves `publish` null, which only suppresses an offer — never
   * claims a privacy setting we haven't read). Called once per page load from
   * App's bootstrap. AutonomySlider still hydrates on its own mount; both write
   * the same store field, so the popover toggle and the card cannot disagree.
   */
  hydrateFromServer: () => Promise<void>;
  /** R2 — report the card's rendered height (px) so the toasts can clear it. */
  setCardHeight: (px: number) => void;
  /**
   * Flip the preference. Optimistic + rolls back and toasts on failure —
   * silently keeping an optimistic `true` would tell the human their taste is
   * being shared across projects when it isn't (and vice versa). Resolves to
   * whether the save landed.
   */
  setPublish: (next: boolean) => Promise<boolean>;
  /**
   * Called after a reject that RECORDED A STANCE. Opens the card iff this
   * project has never answered it and publishing is currently off.
   *
   * `sessionId` is required so the DEMO can be excluded — see the guard below.
   */
  noteStanceRecorded: (sessionId: string | null | undefined) => void;
  /** "Not now" (or the ✕) — answered, never offered again in this project. */
  dismissCard: () => void;
  /** Test seam. */
  reset: () => void;
}

export const useCrossProjectStore = create<CrossProjectState>((set, get) => ({
  publish: null,
  cardVisible: false,
  dismissed: readDismissed(),
  saving: false,
  cardHeight: 0,

  hydratePublish: (value) => set({ publish: value }),

  hydrateFromServer: async () => {
    try {
      const res = await apiGet(`${apiBase()}/api/state`);
      if (!res.ok) return;
      const state = await res.json();
      if (typeof state?.globalLedgerPublish === "boolean") {
        set({ publish: state.globalLedgerPublish });
      }
    } catch {
      // Fail-soft — see the interface note.
    }
  },

  setCardHeight: (px) => set({ cardHeight: Number.isFinite(px) && px > 0 ? px : 0 }),

  setPublish: async (next) => {
    const prev = get().publish;
    set({ publish: next, saving: true });
    try {
      const res = await fetch(`${apiBase()}/api/preferences`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({ globalLedgerPublish: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch {
      // Only roll back if the displayed value is still THIS request's optimistic
      // one (a rapid on→off→on must not clobber the later winner).
      set((s) => (s.publish === next ? { publish: prev } : {}));
      useToastStore.getState().push({
        kind: "error",
        title: "Cross-project publishing not saved",
        body: "It controls whether your stances leave this project, so the change was rolled back.",
      });
      return false;
    } finally {
      set({ saving: false });
    }
  },

  noteStanceRecorded: (sessionId) => {
    const { dismissed, publish, cardVisible } = get();
    if (dismissed || cardVisible) return;
    // Q2 review H3 — NEVER offer this in a demo session. A demo store writes
    // preferences to an in-memory layer that the real session never reads, so
    // enabling from a demo returned success while changing nothing — and,
    // because the card is deliberately one-time, it burned itself on that
    // no-op. The demo IS the recommended first-value path, so this was
    // spending the single best moment we get to offer cross-project memory on
    // a session that structurally cannot accept it. The route refuses the
    // write too (409); this is the half that keeps the offer intact for the
    // real session.
    if (sessionId?.startsWith("demo_")) return;
    // Already publishing → there is nothing to offer. `null` (not yet loaded)
    // is also a no-show: better to miss one prompt than to offer someone an
    // opt-in they already took.
    if (publish !== false) return;
    set({ cardVisible: true });
  },

  dismissCard: () => {
    writeDismissed();
    set({ cardVisible: false, dismissed: true });
  },

  reset: () => set({ publish: null, cardVisible: false, dismissed: false, saving: false, cardHeight: 0 }),
}));
