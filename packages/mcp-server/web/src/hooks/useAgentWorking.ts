import { useEffect, useMemo, useState } from "react";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { AGENT_ACTIVE_WINDOW_MS, lastAgentActivityMs } from "../lib/agentActivity";

/**
 * #455 review — "is the agent working?" from the SAME source TurnIndicator's
 * "Agent working" pill uses: max(newest artifact / agent comment, heartbeat)
 * within AGENT_ACTIVE_WINDOW_MS. The session-bar dot pulses on this, so it
 * can't pulse while the pill says "Up to date" (or the reverse). A one-shot
 * timer flips it at the staleness boundary without needing a re-render.
 */
export function useAgentWorking(): boolean {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const comments = useArtifactStore((s) => s.comments);
  const heartbeat = useConnectionStore((s) => s.agentActivityAt);
  const last = useMemo(
    () => Math.max(lastAgentActivityMs(artifacts, comments), heartbeat ?? 0),
    [artifacts, comments, heartbeat],
  );
  const [, force] = useState(0);
  const working = last > 0 && Date.now() - last < AGENT_ACTIVE_WINDOW_MS;
  useEffect(() => {
    if (!working) return;
    const t = setTimeout(() => force((n) => n + 1), Math.max(last + AGENT_ACTIVE_WINDOW_MS - Date.now(), 0) + 250);
    return () => clearTimeout(t);
  }, [working, last]);
  return working;
}
