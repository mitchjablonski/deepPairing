import { create } from "zustand";
import type { SessionAnnotation } from "@deeppairing/shared";
import { buildTimeline, type TimelineEvent, annotationsByEventId } from "../lib/timeline";
import { apiBase, apiGet, sessionHeaders } from "../lib/api";

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
  options: any[];
  response?: { optionId: string; reasoning?: string };
  createdAt?: string;
  resolvedAt?: string;
}

interface ReplayState {
  active: boolean;
  sessionId: string | null;
  events: TimelineEvent[];
  /** ISO timestamp — every event with e.at <= cursor is "visible". */
  cursor: string;
  playing: boolean;
  speed: 1 | 4 | 16;
  annotations: SessionAnnotation[];
  /** Resolved-decision records; lets DecisionCard show past choices. */
  decisions: DecisionRecord[];

  enterReplay: (sessionId: string, state: {
    artifacts?: any[];
    comments?: any[];
    decisions?: any[];
    planReviews?: any[];
  }) => Promise<void>;
  exitReplay: () => void;
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

let playTimer: ReturnType<typeof setInterval> | null = null;

/** Stop the shared play timer (no-op when already idle). Centralized so the
 *  five previous inline `if (playTimer) { clearInterval(…); playTimer = null; }`
 *  instances stay in sync. */
function clearPlayTimer(): void {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

export const useReplayStore = create<ReplayState>((set, get) => ({
  active: false,
  sessionId: null,
  events: [],
  cursor: "",
  playing: false,
  speed: 1,
  annotations: [],
  decisions: [],

  enterReplay: async (sessionId, state) => {
    const events = buildTimeline(state);
    const initialCursor = events[0]?.at ?? new Date().toISOString();

    // Fetch annotations for this session (best-effort)
    let annotations: SessionAnnotation[] = [];
    try {
      const res = await apiGet(`${apiBase()}/api/sessions/${sessionId}/annotations`);
      if (res.ok) {
        const data = await res.json();
        annotations = data.annotations ?? [];
      }
    } catch {}

    clearPlayTimer();
    set({
      active: true,
      sessionId,
      events,
      cursor: initialCursor,
      playing: false,
      speed: 1,
      annotations,
      decisions: (state.decisions ?? []) as DecisionRecord[],
    });
  },

  exitReplay: () => {
    const wasActive = get().active;
    clearPlayTimer();
    set({ active: false, sessionId: null, events: [], cursor: "", playing: false, annotations: [], decisions: [] });
    // H1 — loadSession RESET the live artifact store and filled it with the
    // historical session; exiting used to leave that store in place, so
    // historical drafts rendered with fully-mutable footers (the F12 guard
    // off) and owner-routed writes landed in the dead session — the exact
    // mixed-frame lie F12 killed, resurrected at exit. Rehydrate: a bound
    // tab re-binds (hydration resets then refills from live state); an
    // unbound one just resets. Dynamic imports keep this store cycle-free.
    if (!wasActive) return;
    void Promise.all([import("./connection"), import("./artifact")]).then(
      ([{ useConnectionStore }, { useArtifactStore }]) => {
        // Review — reset UNCONDITIONALLY first: the VS Code webview adapter
        // has no switchSession, so the rehydrate silently no-op'd there and
        // the historical store stayed live. A double reset is harmless (the
        // connected handler resets again before hydration).
        useArtifactStore.getState().reset();
        const sid = useConnectionStore.getState().sessionId;
        if (sid) useConnectionStore.getState().switchSession(sid);
      },
    );
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
