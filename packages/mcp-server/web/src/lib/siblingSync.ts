import { create } from "zustand";

/**
 * #467 review — has MultiAgentSync finished a pass over the sessions it knows
 * since the last store reset? Until it has, an empty Decide lane may just mean
 * "siblings not merged yet", so the Next-up bar holds a neutral line instead
 * of claiming "Nothing needs you" (the load-time flash: reset → bare
 * "nothing" → the real line ~20ms later).
 */
export const useSiblingSyncStore = create<{ settled: boolean }>(() => ({ settled: false }));
