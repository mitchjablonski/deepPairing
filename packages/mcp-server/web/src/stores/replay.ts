import { create } from "zustand";
import type { SessionAnnotation, DecisionOption } from "@deeppairing/shared";
import { buildTimeline, type TimelineEvent, type TimelineInput, annotationsByEventId } from "../lib/timeline";
import { apiBase, apiGet, sessionHeaders } from "../lib/api";
import {
  beginSessionTransition,
  isCurrentSessionTransition,
  type SessionTransitionToken,
} from "../lib/session-transition";

/**
 * Replay mode state — active when the user opens a past session from
 * SessionBrowser. The ArtifactPanel consumes `cursor` + `events` to render
 * only the state as it existed at the cursor timestamp.
 *
 * Kept as a separate store from `artifact` so entering/exiting replay doesn't
 * disturb the live-session store for active sessions.
 */
interface DecisionRecord {
  decisionId: string;
  artifactId: string;
  context: string;
  options: DecisionOption[];
  response?: { optionId: string; reasoning?: string };
  createdAt?: string;
  resolvedAt?: string;
}

/**
 * Q5 — the exit rehydrate, made AWAITABLE.
 *
 * `exitReplay` fires a dynamic import (see below) to rehydrate the live stores
 * without a static import cycle. It used to be a bare `void Promise.all(...)`:
 * nothing could know when it finished, so a test (or a teardown) that ran out
 * from under it left the module load in flight — under vitest that surfaces as
 * `EnvironmentTeardownError: Cannot load .../hookStatus.ts ... after the
 * environment was torn down`: a scheduling-sensitive flake that passes locally
 * and fires on a loaded CI box (it appeared when an unrelated web-dom test file
 * shifted the pool's scheduling). Keeping the handle costs nothing and makes
 * the race observable instead of latent.
 */
let rehydrateInFlight: Promise<void> | null = null;

/** Resolves once any in-flight `exitReplay` rehydrate has settled (immediately
 *  when there is none). For tests, and for any caller that must not race it. */
export function replayRehydrateSettled(): Promise<void> {
  return rehydrateInFlight ?? Promise.resolve();
}

interface ReplayState {
  active: boolean;
  /** Exit requested, but historical state remains read-only until it has been
   * cleared and (for a browser tab) replaced by the live snapshot. */
  exiting: boolean;
  sessionId: string | null;
  events: TimelineEvent[];
  /** ISO timestamp — every event with e.at <= cursor is "visible". */
  cursor: string;
  playing: boolean;
  speed: 1 | 4 | 16;
  annotations: SessionAnnotation[];
  /** Resolved-decision records; lets DecisionCard show past choices. */
  decisions: DecisionRecord[];

  enterReplay: (
    sessionId: string,
    state: TimelineInput,
    transition?: SessionTransitionToken,
  ) => Promise<void>;
  exitReplay: () => void;
  completeExit: () => void;
  setCursor: (cursor: string) => void;
  stepForward: () => void;
  stepBackward: () => void;
  play: () => void;
  pause: () => void;
  setSpeed: (s: 1 | 4 | 16) => void;
  addAnnotation: (targetEventId: string, note: string, tags?: string[]) => Promise<void>;
  removeAnnotation: (annotationId: string) => Promise<void>;
}

/**
 * Base tick rate for replay playback at 1× speed. Higher speeds divide this
 * — see the `Math.max(120, …)` floor in play().
 */
const REPLAY_BASE_TICK_MS = 1200;
const REPLAY_MIN_TICK_MS = 120;
const REPLAY_EXIT_TIMEOUT_MS = 10_000;

let playTimer: ReturnType<typeof setInterval> | null = null;
let exitRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let exitRecoveryToastId: string | null = null;
let replayOperation = 0;

/** Stop the shared play timer (no-op when already idle). Centralized so the
 *  five previous inline `if (playTimer) { clearInterval(…); playTimer = null; }`
 *  instances stay in sync. */
function clearPlayTimer(): void {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

function clearExitRecoveryTimer(): void {
  if (exitRecoveryTimer) {
    clearTimeout(exitRecoveryTimer);
    exitRecoveryTimer = null;
  }
}

function dismissExitRecoveryToast(): void {
  const toastId = exitRecoveryToastId;
  exitRecoveryToastId = null;
  if (toastId) {
    void import("./toast").then(({ useToastStore }) => {
      useToastStore.getState().dismiss(toastId);
    });
  }
}

/**
 * Leaving replay is intentionally fail-closed: the historical frame remains
 * visible under the replay write lock until a full live snapshot arrives.
 * A timeout offers a retry, but never turns stale history into editable data.
 */
function scheduleExitRecoveryTimeout(operation: number): void {
  clearExitRecoveryTimer();
  dismissExitRecoveryToast();
  exitRecoveryTimer = setTimeout(() => {
    exitRecoveryTimer = null;
    if (operation !== replayOperation || !useReplayStore.getState().exiting) return;
    void import("./toast").then(({ useToastStore }) => {
      if (operation !== replayOperation || !useReplayStore.getState().exiting) return;
      exitRecoveryToastId = useToastStore.getState().push({
        kind: "error",
        title: "Couldn't leave replay",
        body: "Live session state has not arrived. Replay remains read-only; retry when the daemon reconnects.",
        ttl: 0,
        action: {
          label: "Retry",
          onClick: () => {
            if (operation !== replayOperation || !useReplayStore.getState().exiting) return;
            dismissExitRecoveryToast();
            useReplayStore.getState().exitReplay();
          },
        },
      });
    });
  }, REPLAY_EXIT_TIMEOUT_MS);
}

export const useReplayStore = create<ReplayState>((set, get) => ({
  active: false,
  exiting: false,
  sessionId: null,
  events: [],
  cursor: "",
  playing: false,
  speed: 1,
  annotations: [],
  decisions: [],

  enterReplay: async (sessionId, state, suppliedTransition) => {
    const operation = ++replayOperation;
    const transition = suppliedTransition ?? beginSessionTransition(sessionId);
    const events = buildTimeline(state);
    const initialCursor = events[0]?.at ?? new Date().toISOString();

    // `active` is the write lock. Commit it before annotation I/O yields and
    // before enterSessionReplay installs any historical artifacts.
    clearPlayTimer();
    clearExitRecoveryTimer();
    dismissExitRecoveryToast();
    set({
      active: true,
      exiting: false,
      sessionId,
      events,
      cursor: initialCursor,
      playing: false,
      speed: 1,
      annotations: [],
      decisions: (state.decisions ?? []) as DecisionRecord[],
    });

    // Fetch annotations for this session (best-effort)
    let annotations: SessionAnnotation[] = [];
    try {
      const res = await apiGet(`${apiBase()}/api/sessions/${sessionId}/annotations`);
      if (res.ok) {
        const data = await res.json();
        annotations = data.annotations ?? [];
      }
    } catch {}

    if (
      operation === replayOperation &&
      isCurrentSessionTransition(transition) &&
      get().active &&
      !get().exiting &&
      get().sessionId === sessionId
    ) {
      set({ annotations });
    }
  },

  exitReplay: () => {
    const wasActive = get().active;
    const operation = ++replayOperation;
    const transition = wasActive ? beginSessionTransition(null) : null;
    clearPlayTimer();
    // Keep the write lock until the historical store is cleared and the live
    // snapshot, when available, has replaced it.
    if (wasActive) set({ exiting: true, playing: false });
    // H1 — loadSession RESET the live artifact store and filled it with the
    // historical session; exiting used to leave that store in place, so
    // historical drafts rendered with fully-mutable footers (the F12 guard
    // off) and owner-routed writes landed in the dead session — the exact
    // mixed-frame lie F12 killed, resurrected at exit. Rehydrate: a bound
    // tab re-binds (hydration resets then refills from live state); an
    // unbound one just resets. Dynamic imports keep this store cycle-free.
    if (!wasActive) return;
    scheduleExitRecoveryTimeout(operation);
    rehydrateInFlight = Promise.all([import("./connection"), import("./artifact")]).then(
      ([{ useConnectionStore }, { useArtifactStore }]) => {
        if (
          operation !== replayOperation ||
          !get().exiting ||
          !transition ||
          !isCurrentSessionTransition(transition)
        ) return;
        const connection = useConnectionStore.getState();
        const sid = connection.sessionId;
        const canRehydrate = Boolean(
          sid && connection.adapter && "switchSession" in connection.adapter,
        );
        if (canRehydrate && sid) {
          // Preserve the historical frame until connected.state atomically
          // replaces it. `active` remains the write lock throughout.
          connection.switchSession(sid, { preserveStateUntilConnected: true });
        } else {
          // An adapter without session switching cannot deliver a replacement
          // snapshot, so discard history before releasing the write lock.
          useArtifactStore.getState().reset();
          get().completeExit();
        }
      },
    ).catch(() => {
      // The bounded recovery timer owns user-visible failure and retry. Keep
      // the historical frame locked instead of falling through to edits.
    });
    void rehydrateInFlight;
  },

  completeExit: () => {
    if (!get().exiting) return;
    clearPlayTimer();
    clearExitRecoveryTimer();
    dismissExitRecoveryToast();
    set({ active: false, exiting: false, sessionId: null, events: [], cursor: "", playing: false, annotations: [], decisions: [] });
  },

  setCursor: (cursor) => set({ cursor }),

  stepForward: () => {
    const { events, cursor } = get();
    const next = events.find((e) => e.at > cursor);
    if (next) set({ cursor: next.at });
  },

  stepBackward: () => {
    const { events, cursor } = get();
    const reversed = [...events].reverse();
    const prev = reversed.find((e) => e.at < cursor);
    if (prev) set({ cursor: prev.at });
  },

  play: () => {
    if (playTimer) return;
    set({ playing: true });
    const tick = () => {
      const { events, cursor, speed } = get();
      const idx = events.findIndex((e) => e.at === cursor);
      const nextEvent = events[idx + 1];
      if (!nextEvent) {
        clearPlayTimer();
        set({ playing: false });
        return;
      }
      set({ cursor: nextEvent.at });
      // Reschedule with current speed (keeps tick rate honest when speed
      // changes mid-playback).
      clearPlayTimer();
      playTimer = setInterval(tick, Math.max(REPLAY_MIN_TICK_MS, REPLAY_BASE_TICK_MS / speed));
    };
    playTimer = setInterval(tick, REPLAY_BASE_TICK_MS / get().speed);
  },

  pause: () => {
    clearPlayTimer();
    set({ playing: false });
  },

  setSpeed: (s) => {
    set({ speed: s });
    // If we're playing, restart the timer at the new cadence.
    if (get().playing) {
      get().pause();
      get().play();
    }
  },

  addAnnotation: async (targetEventId, note, tags) => {
    const { sessionId, annotations } = get();
    if (!sessionId) return;
    try {
      const res = await fetch(`${apiBase()}/api/sessions/${sessionId}/annotations`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({ targetEventId, note, tags }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.annotation) {
          set({ annotations: [...annotations, data.annotation] });
        }
      }
    } catch {}
  },

  removeAnnotation: async (annotationId) => {
    const { sessionId, annotations } = get();
    if (!sessionId) return;
    try {
      await fetch(`${apiBase()}/api/sessions/${sessionId}/annotations/${annotationId}`, {
        method: "DELETE",
        headers: sessionHeaders(),
      });
      set({ annotations: annotations.filter((a) => a.id !== annotationId) });
    } catch {}
  },
}));

/** Helper for consumers that want per-event annotations map. */
export function useAnnotationsByEvent() {
  const annotations = useReplayStore((s) => s.annotations);
  return annotationsByEventId(annotations);
}
