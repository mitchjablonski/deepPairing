/**
 * Single source of truth for "is any agent still live?" — the exact predicate
 * the ResumeQuestionsBanner, the TurnIndicator exited pill, and the sent-toast
 * copy all route through, so none of them can drift.
 *
 * An exited wrapper is marked `live:false`; a session with `live` undefined is
 * an older daemon and treated as live (no false alarms on mixed versions);
 * an empty session list is also "no agent".
 */
export function noAgentLive(activeSessions: Array<{ live?: boolean }>): boolean {
  return !activeSessions.some((s) => s.live !== false);
}
