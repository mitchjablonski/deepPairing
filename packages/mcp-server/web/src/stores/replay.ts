import { create } from "zustand";
import type { SessionAnnotation } from "@deeppairing/shared";
import { buildTimeline, type TimelineEvent, annotationsByEventId } from "../lib/timeline";
import { API_BASE } from "../lib/api";

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
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/annotations`);
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
    clearPlayTimer();
    set({ active: false, sessionId: null, events: [], cursor: "", playing: false, annotations: [], decisions: [] });
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
      const nextIdx = idx + 1;
      if (nextIdx >= events.length) {
        clearPlayTimer();
        set({ playing: false });
        return;
      }
      set({ cursor: events[nextIdx].at });
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
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      await fetch(`${API_BASE}/api/sessions/${sessionId}/annotations/${annotationId}`, {
        method: "DELETE",
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
