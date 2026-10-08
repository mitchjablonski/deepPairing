import { apiGet, apiBase } from "./api";
import { useReplayStore } from "../stores/replay";
import { hydrateArtifactSession } from "./session-hydration";
import { beginSessionTransition, isCurrentSessionTransition } from "./session-transition";

/**
 * #469 — the outcome of a cross-session open, so a caller can tell a genuine
 * load failure (show it, offer retry) from a transition that simply lost the
 * race to newer navigation or was cancelled by its caller (say nothing).
 */
export type SessionReplayResult =
  | { status: "opened" }
  | { status: "superseded" }
  | { status: "cancelled" }
  | { status: "failed"; kind: "http" | "network" | "invalid"; message: string };

export interface OpenSessionReplayOptions {
  /** Aborting before the replay is committed cancels the open (and its fetch). */
  signal?: AbortSignal;
}

const STATE_ARRAY_FIELDS = ["artifacts", "comments", "decisions", "requests"] as const;

function isSessionState(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return STATE_ARRAY_FIELDS.every((f) => record[f] === undefined || Array.isArray(record[f]));
}

/**
 * #138 — the ONE cross-session navigation scheme: open a past session in
 * read-only REPLAY mode, optionally landing on a specific artifact. Extracted
 * verbatim from SessionBrowser.loadSession so the project-wide DecisionsView's
 * "jump to this decision in its session" click behaves IDENTICALLY to clicking
 * a cross-session search result — no second routing scheme.
 *
 * Fetches the historical session state, resets the live artifact store, refills
 * it, seeds the agent-acknowledged decision receipts, then enters replay (the
 * ReplayScrubber above ArtifactPanel hides events after the cursor). When
 * `focusArtifactId` is given, advances the scrubber to that artifact's creation
 * event and selects it — selectArtifact resolves a superseded id to its live
 * successor, so a decision whose artifact was revised still lands on v2.
 *
 * Never rejects: HTTP failures, network rejections and unusable payloads come
 * back as `failed`; losing to newer navigation is `superseded`; an aborted
 * `signal` before the replay commits is `cancelled`.
 */
export async function openSessionReplay(
  sessionId: string,
  focusArtifactId?: string,
  options: OpenSessionReplayOptions = {},
): Promise<SessionReplayResult> {
  const { signal } = options;
  if (signal?.aborted) return { status: "cancelled" };
  const transition = beginSessionTransition(sessionId);
  // Superseded wins over cancelled/failed: newer navigation owns the screen.
  const settle = (fallback: SessionReplayResult): SessionReplayResult => {
    if (!isCurrentSessionTransition(transition)) return { status: "superseded" };
    if (signal?.aborted) return { status: "cancelled" };
    return fallback;
  };

  // Response.json() is typed `any`; keep it inferred (no explicit `any`
  // annotation) so the store's own types apply at each call site below.
  let state = undefined as Awaited<ReturnType<Response["json"]>>;
  try {
    const res = await apiGet(`${apiBase()}/api/sessions/${sessionId}`, { signal });
    if (!res.ok) {
      return settle({
        status: "failed",
        kind: "http",
        message: `The session couldn't be loaded (HTTP ${res.status}).`,
      });
    }
    try {
      state = await res.json();
    } catch {
      return settle({ status: "failed", kind: "invalid", message: "The session returned an unreadable response." });
    }
  } catch {
    return settle({ status: "failed", kind: "network", message: "Couldn't reach the deepPairing server." });
  }
  const before = settle({ status: "opened" });
  if (before.status !== "opened") return before;
  if (!isSessionState(state)) {
    return { status: "failed", kind: "invalid", message: "The session returned an unreadable response." };
  }

  try {
    // enterReplay flips the read-only gate synchronously, before its annotation
    // request yields. Historical artifacts can only become visible after that.
    const sessionState = state;
    const enteringReplay = useReplayStore.getState().enterReplay(sessionId, sessionState, transition);
    if (!isCurrentSessionTransition(transition)) return { status: "superseded" };
    hydrateArtifactSession(sessionState, { focusArtifactId });
    await enteringReplay;
    if (!isCurrentSessionTransition(transition)) return { status: "superseded" };

    if (focusArtifactId) {
      const target = (sessionState.artifacts ?? []).find(
        (a: { id?: string; createdAt?: string }) => a.id === focusArtifactId,
      );
      if (target?.createdAt) {
        useReplayStore.getState().setCursor(target.createdAt);
      }
    }
  } catch {
    if (!isCurrentSessionTransition(transition)) return { status: "superseded" };
    return { status: "failed", kind: "invalid", message: "The session's history couldn't be opened." };
  }
  return { status: "opened" };
}

/**
 * Boolean form kept for existing callers: true on success, false on any
 * failure or superseded transition. Never rejects.
 */
export async function enterSessionReplay(
  sessionId: string,
  focusArtifactId?: string,
): Promise<boolean> {
  return (await openSessionReplay(sessionId, focusArtifactId)).status === "opened";
}
