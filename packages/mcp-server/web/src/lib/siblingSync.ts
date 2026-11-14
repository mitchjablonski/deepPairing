import { create } from "zustand";

/**
 * #467 review — has MultiAgentSync finished a pass over the sessions it knows
 * since the last store reset? Until it has, an empty Decide lane may just mean
 * "siblings not merged yet", so the Next-up bar holds a neutral line instead
 * of claiming "Nothing needs you" (the load-time flash: reset → bare
 * "nothing" → the real line ~20ms later).
 */
export const useSiblingSyncStore = create<{ settled: boolean }>(() => ({ settled: false }));

/** Loaded/change/backoff state shares the baseline lifetime so a remount neither
 * refetches quiet history nor restarts empty polling. One live store frame's transient sibling classification; never a visit receipt. */
interface SiblingFrame {
  generation: number;
  sessionId: string | null;
  projectRoot: string | null;
  baseline: Set<string>;
  loaded: Set<string>;
  fetched: Map<string, string>;
  forced: Set<string>;
  attempted: Map<string, number>;
  flights: Map<string, { token: symbol; owner: symbol; controller: AbortController }>;
}
let frame: SiblingFrame | undefined;
export function siblingFrame(generation: number, sessionId: string | null, projectRoot: string | null): SiblingFrame {
  if (!frame || frame.generation !== generation || frame.sessionId !== sessionId ||
      (!!frame.projectRoot && !!projectRoot && frame.projectRoot !== projectRoot)) {
    if (frame) cancelSiblingFlights(frame);
    frame = { generation, sessionId, projectRoot, baseline: new Set(), loaded: new Set(),
      fetched: new Map(), forced: new Set(), attempted: new Map(), flights: new Map() };
    useSiblingSyncStore.setState({ settled: false });
  } else if (projectRoot) frame.projectRoot = projectRoot;
  return frame;
}
export function cancelSiblingFlights(current: SiblingFrame, owner?: symbol): void {
  for (const [id, flight] of current.flights) {
    if (owner && flight.owner !== owner) continue;
    flight.controller.abort();
    current.flights.delete(id);
    current.attempted.delete(id);
  }
}
