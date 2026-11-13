import { useEffect } from "react";
import { sessionVisits } from "../lib/session-visits";
import { useArtifactStore } from "../stores/artifact";
import { useReplayStore } from "../stores/replay";
import { useConnectionStore, selectHydratedForBinding } from "../stores/connection";
import { isDemoSessionId } from "@deeppairing/shared";

/** Visibility resumes observation, never navigation. Hidden/replay/sample frames do not acknowledge history. */
export function useSessionVisits(): void {
  useEffect(() => {
    const resume = () => {
      if (document.hidden || useReplayStore.getState().active) return;
      const state = useArtifactStore.getState();
      const connection = useConnectionStore.getState();
      if (state.sampleContent || isDemoSessionId(connection.sessionId ?? "") ||
          !selectHydratedForBinding(connection) || !sessionVisits.matches(connection.sessionId, connection.projectRoot)) return;
      const unread = sessionVisits.observe(state.artifacts, state.selectedArtifactId);
      if (unread) useArtifactStore.setState({ unreadIds: sessionVisits.mergeUnread(state.unreadIds, state.artifacts, unread) });
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);
}
