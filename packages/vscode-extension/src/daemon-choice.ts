/**
 * #727 — which daemon the webview follows in a multi-root workspace.
 *
 * Pure (no `vscode` import) so it is unit-testable.
 *
 * Each folder's daemon rewrites its `.deeppairing/daemon.json` every ~30 s, so
 * "the freshest file" flips between folders on every heartbeat. The webview
 * document is rebuilt when the daemon changes (its CSP `frame-src` names the
 * port), so following the freshest file would wipe drafts and scroll every
 * beat. Instead the current daemon is kept while some daemon.json still
 * advertises its port and that file is fresh; the view switches only when it
 * is removed, rewritten with another port, or goes stale with a fresh
 * alternative available.
 */

/** A daemon.json not rewritten for this long (3 missed 30 s heartbeats) is stale. */
export const DAEMON_STALE_MS = 90_000;

export interface DaemonCandidate {
  port: number;
  mtimeMs: number;
}

/** The port to follow, given the current one and every discovered daemon.json. */
export function chooseDaemonPort(
  current: number | null,
  candidates: readonly DaemonCandidate[],
  now: number,
  staleMs: number = DAEMON_STALE_MS,
): number | null {
  if (candidates.length === 0) return current;
  const isFresh = (c: DaemonCandidate) => now - c.mtimeMs <= staleMs;
  const freshest = candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  if (current === null) return freshest.port;
  const mine = candidates.filter((c) => c.port === current);
  if (mine.length === 0) return freshest.port;
  if (mine.some(isFresh)) return current;
  // Current is stale: move only to a fresh alternative.
  return isFresh(freshest) ? freshest.port : current;
}
