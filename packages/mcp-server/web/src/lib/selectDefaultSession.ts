/**
 * Default-view session selection for the companion bootstrap.
 *
 * With the per-Claude-session split a single project can now hold MANY live
 * artifact buckets at once (concurrent Claude conversations, each keyed off its
 * own CLAUDE_CODE_SESSION_ID). The daemon retains dead sessions in insertion
 * order, so the old "first live" rule bound the tab to whichever live session
 * happened to register earliest — not the conversation the human is actually
 * in. This picks the MOST-RECENTLY-ACTIVE live session instead.
 *
 * Single-session projects are unchanged by construction: one live candidate
 * means it is trivially the most-recent, so the return value matches the
 * pre-split "first live" behavior exactly.
 */
export interface SelectableSession {
  sessionId: string;
  live?: boolean;
  /** ISO timestamp of the session's last internal-route activity. */
  lastActivity?: string;
}

function activityMs(s: SelectableSession): number {
  const t = s.lastActivity ? Date.parse(s.lastActivity) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Choose the session the companion should bind to on load.
 *
 * Rule: among LIVE sessions (live !== false), the one with the most-recent
 * lastActivity. Ties resolve to the earlier session in the list (stable —
 * matches insertion order). If no session is live, falls back to the first
 * session so a cold page with only dead history still shows something. Returns
 * undefined only for an empty list.
 */
export function selectDefaultSession(
  sessions: SelectableSession[],
): SelectableSession | undefined {
  if (sessions.length === 0) return undefined;
  const live = sessions.filter((s) => s.live !== false);
  const mostRecentLive = live.reduce<SelectableSession | undefined>(
    (best, s) => (best && activityMs(best) >= activityMs(s) ? best : s),
    undefined,
  );
  return mostRecentLive ?? sessions[0];
}
