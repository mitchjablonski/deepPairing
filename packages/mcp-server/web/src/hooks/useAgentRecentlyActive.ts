import { useEffect, useState } from "react";
import { useConnectionStore } from "../stores/connection";
import { AGENT_ACTIVE_WINDOW_MS } from "../lib/agentActivity";

/**
 * D8/D9 — heartbeat recency with a one-shot timer to the staleness boundary.
 * Computing recency at render silently freezes once the agent exits: the D6
 * equality bail suppresses idle re-renders, so nothing recomputes it — the
 * exact trap both the composer copy (M3) and the closing-beat gate (H3) fell
 * into independently.
 *
 * #430 PR 1b — the default is the shared AGENT_ACTIVE_WINDOW_MS, the same window
 * TurnIndicator's pill uses. RequestComposerBanner passes its own 90s #204
 * hysteresis explicitly and is unaffected.
 */
export function useAgentRecentlyActive(windowMs = AGENT_ACTIVE_WINDOW_MS): boolean {
  const recentlyActive = useConnectionStore(
    (st) => st.agentActivityAt != null && Date.now() - st.agentActivityAt < windowMs,
  );
  const agentActivityAt = useConnectionStore((st) => st.agentActivityAt);
  const [, force] = useState(0);
  useEffect(() => {
    if (!recentlyActive || agentActivityAt == null) return;
    const msUntilStale = agentActivityAt + windowMs - Date.now();
    const t = setTimeout(() => force((n) => n + 1), Math.max(msUntilStale, 0) + 250);
    return () => clearTimeout(t);
  }, [recentlyActive, agentActivityAt, windowMs]);
  return recentlyActive;
}
