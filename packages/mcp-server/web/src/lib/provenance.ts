import { isDemoSessionId } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { useReplayStore } from "../stores/replay";

/**
 * #569 proposal 1 — is what the companion is showing REAL work or
 * deepPairing's own demo/sample content?
 *
 * Pilot input: Mitch approved a real brief and a day later asked "the demo
 * example?" — real cards looked identical to demo cards. This answers the
 * question from EXISTING signals only (no new schema field, no git call):
 *   - "sample": the client-side "try the demo session" fixture is loaded
 *     (artifact store `sampleContent`, set only by SessionBrowser.loadDemo)
 *     AND the session is one of the fixture's own — a real session id wins;
 *   - "demo":   the session id is a demo/sample id (`isDemoSessionId` — the
 *     `demo_` prefix only POST /api/demo/run mints, plus the repo's own
 *     checked-in sample ids; the same rule Threads uses for `fixtureLike`);
 *   - "live":   anything else. Legacy sessions carry no provenance metadata,
 *     so they default to live — a false "demo" label on real work would make
 *     the human discount a card that mattered, the exact failure being fixed.
 *
 * Labelling only. Nothing may gate, count, route or attend on this.
 */
export type ProvenanceKind = "live" | "demo" | "sample";

export interface Provenance {
  kind: ProvenanceKind;
  /** The project the work belongs to (live only); null when unknown. */
  projectName: string | null;
  /** Viewing a past session's history (replay) rather than the live run. */
  history: boolean;
}

/** Last path segment of a project root, POSIX or Windows. */
export function projectNameFromRoot(root: string | null | undefined): string | null {
  if (!root) return null;
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

export function classifyProvenance(input: {
  sessionId: string | null | undefined;
  sampleContent?: boolean;
  /** The sample fixture's own session ids — the only ids the flag labels. */
  sampleSessionIds?: readonly string[];
  projectName?: string | null;
  history?: boolean;
}): Provenance | null {
  // The session id wins: the sample flag labels only the fixture's own
  // sessions (or the session-less offline preview), never a real session.
  if (input.sampleContent && (!input.sessionId || (input.sampleSessionIds ?? []).includes(input.sessionId))) {
    return { kind: "sample", projectName: null, history: false };
  }
  if (!input.sessionId) return null;
  if (isDemoSessionId(input.sessionId)) return { kind: "demo", projectName: null, history: !!input.history };
  return { kind: "live", projectName: input.projectName ?? null, history: !!input.history };
}

/**
 * The provenance of what is on screen. `sessionId` overrides the bound
 * session — the artifact panel passes the SELECTED artifact's session, since
 * MultiAgentSync can merge several sessions (a demo beside real work) into one
 * panel. Returns null when there is nothing to label (no session at all).
 */
export function useProvenance(sessionIdOverride?: string | null): Provenance | null {
  const sampleContent = useArtifactStore((s) => s.sampleContent);
  const sampleSessionIds = useArtifactStore((s) => s.sampleSessionIds);
  const boundSessionId = useConnectionStore((s) => s.sessionId);
  const projectRoot = useConnectionStore((s) => s.projectRoot);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const replayActive = useReplayStore((s) => s.active);
  const replaySessionId = useReplayStore((s) => s.sessionId);
  const sessionId = sessionIdOverride ?? (replayActive && replaySessionId ? replaySessionId : boundSessionId);
  const fromSession = activeSessions.find((s) => s.sessionId === sessionId)?.project;
  return classifyProvenance({
    sessionId,
    sampleContent,
    sampleSessionIds,
    projectName: fromSession || projectNameFromRoot(projectRoot),
    history: replayActive,
  });
}
