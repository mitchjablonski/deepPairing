import { create } from "zustand";
import type { AgentEvent } from "@deeppairing/shared";
import { useCodeStore } from "./code";
import { useArtifactStore } from "./artifact";

const API_BASE = "http://localhost:3001";

export interface SessionState {
  sessionId: string | null;
  status: "idle" | "connecting" | "gathering" | "presenting" | "executing" | "completed" | "error";
  events: AgentEvent[];
  error: string | null;

  startSession: (prompt: string, cwd: string) => Promise<void>;
  stopSession: () => Promise<void>;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => {
  let eventSource: EventSource | null = null;

  return {
    sessionId: null,
    status: "idle",
    events: [],
    error: null,

    startSession: async (prompt: string, cwd: string) => {
      // Clean up any existing connection
      eventSource?.close();
      set({ status: "connecting", events: [], error: null });

      try {
        const res = await fetch(`${API_BASE}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, cwd }),
        });

        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error ?? "Failed to create session");
        }

        const { sessionId } = await res.json();
        set({ sessionId });

        // Open SSE stream
        eventSource = new EventSource(
          `${API_BASE}/api/sessions/${sessionId}/stream`,
        );

        eventSource.addEventListener("connected", () => {
          set({ status: "gathering" });
        });

        // Listen for all agent event types
        const eventTypes = [
          "text", "tool_call", "tool_result", "thinking",
          "status", "result", "error", "decision_request",
          "reasoning", "findings", "code_change",
          "artifact_created", "artifact_updated", "comment_added",
          "plan_review_request",
        ];

        for (const type of eventTypes) {
          eventSource.addEventListener(type, (e) => {
            const event: AgentEvent = JSON.parse(e.data);

            set((state) => {
              const updates: Partial<SessionState> = {
                events: [...state.events, event],
              };

              // Update status based on status events
              if (event.type === "status") {
                updates.status = event.phase;
              }
              if (event.type === "error") {
                updates.status = "error";
                updates.error = event.message;
              }

              // Forward code changes to the code store
              if (event.type === "code_change") {
                useCodeStore.getState().addChange(event);
              }

              // Forward artifact events to the artifact store
              if (event.type === "artifact_created") {
                useArtifactStore.getState().addArtifact(event.artifact);
              }
              if (event.type === "artifact_updated") {
                useArtifactStore.getState().updateArtifact(
                  event.artifactId,
                  event.status,
                  event.version,
                );
              }
              if (event.type === "comment_added") {
                useArtifactStore.getState().addComment(event.comment);
              }

              return updates as SessionState;
            });
          });
        }

        eventSource.addEventListener("done", () => {
          set((state) => ({
            status: state.status === "error" ? "error" : "completed",
          }));
          eventSource?.close();
          eventSource = null;
        });

        eventSource.onerror = () => {
          set({ status: "error", error: "Connection lost" });
          eventSource?.close();
          eventSource = null;
        };
      } catch (err) {
        set({
          status: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },

    stopSession: async () => {
      const { sessionId } = get();
      if (!sessionId) return;

      eventSource?.close();
      eventSource = null;

      await fetch(`${API_BASE}/api/sessions/${sessionId}/stop`, {
        method: "POST",
      }).catch(() => {});

      set({ status: "completed" });
    },

    reset: () => {
      eventSource?.close();
      eventSource = null;
      useCodeStore.getState().reset();
      useArtifactStore.getState().reset();
      set({
        sessionId: null,
        status: "idle",
        events: [],
        error: null,
      });
    },
  };
});
