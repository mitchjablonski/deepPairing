/**
 * #457 D2 — one name for a session, shared by the session bar (App) and the
 * Next-up bar's session label, so "which session is blocked?" reads the same
 * word in both places: its title (when it isn't just the id), else its
 * project, else "Session N" by position.
 */
export interface SessionLike {
  sessionId: string;
  title?: string | null;
  project?: string | null;
}

export function sessionLabelOf(s: SessionLike, index: number): string {
  return s.title && s.title !== s.sessionId ? s.title : s.project ? s.project : `Session ${index + 1}`;
}

export function sessionLabelsFrom(sessions: SessionLike[]): Record<string, string> {
  const out: Record<string, string> = {};
  sessions.forEach((s, i) => { out[s.sessionId] = sessionLabelOf(s, i); });
  return out;
}
