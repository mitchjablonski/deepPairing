import { useTabOffline } from "../lib/connectionGrace";

/**
 * #465 (design §4.3 rule 1 / state G) — act buttons (approve, reject,
 * resolve, send) are DISABLED while this tab is disconnected from the daemon,
 * with the reason as their tooltip, in both bar modes. They re-enable on
 * reconnect. Only the BUTTONS are gated: composers stay editable, so nothing
 * typed is lost. Returns the reason, or null when connected.
 *
 * #487 review (Fable) — a `disabled` button leaves the tab order, so a
 * keyboard / screen-reader user never lands on it to hear this tooltip. The
 * reason reaches them through the role=status DisconnectBanner (and the bar's
 * DISCONNECTED prefix), which announces the outage once.
 */
export const OFFLINE_ACT_REASON =
  "This tab is disconnected from the deepPairing daemon — this re-enables when it reconnects (anything you've typed is kept)";

export function useOfflineReason(): string | null {
  // #467 review — the SAME offline condition as the bar and the banner
  // (lib/connectionGrace): it also covers a fatal stale-daemon mismatch, which
  // sets connected:false without a disconnectedSince stamp.
  return useTabOffline() ? OFFLINE_ACT_REASON : null;
}
