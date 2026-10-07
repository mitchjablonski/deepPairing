import { useConnectionStore } from "../stores/connection";

/**
 * #465 (design §4.3 rule 1 / state G) — act buttons (approve, reject,
 * resolve, send) are DISABLED while this tab is disconnected from the daemon,
 * with the reason as their tooltip, in both bar modes. They re-enable on
 * reconnect. Only the BUTTONS are gated: composers stay editable, so nothing
 * typed is lost. Returns the reason, or null when connected.
 */
export const OFFLINE_ACT_REASON =
  "This tab is disconnected from the deepPairing daemon — this re-enables when it reconnects (anything you've typed is kept)";

export function useOfflineReason(): string | null {
  // A real outage: not connected AND a disconnect was observed (the store
  // stamps disconnectedSince on the transport dropping, and clears it on a
  // connect). Before the first connect there is nothing loaded to act on.
  const offline = useConnectionStore((s) => !s.connected && s.disconnectedSince != null);
  return offline ? OFFLINE_ACT_REASON : null;
}
