import { create } from "zustand";
import type { Artifact, Comment } from "@deeppairing/shared";

/** Request notification permission and send a notification when tab is unfocused */
function notifyIfUnfocused(title: string, body: string) {
  if (typeof Notification === "undefined") return;
  if (document.hasFocus()) return;

  if (Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon.ico" });
  } else if (Notification.permission === "default") {
    Notification.requestPermission();
  }
}

interface ConnectionState {
  connected: boolean;
  sessionId: string | null;
  ws: WebSocket | null;

  connect: () => void;
  disconnect: () => void;
}

const WS_URL = `ws://${window.location.host}/ws`;

export const useConnectionStore = create<ConnectionState>((set, get) => {
  function handleMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(event.data);

      // Import artifact store lazily to avoid circular deps
      import("./artifact").then(({ useArtifactStore }) => {
        const store = useArtifactStore.getState();

        switch (data.type) {
          case "connected":
            set({ sessionId: data.state?.sessionId ?? null });
            // Reset before hydration to prevent duplicates on reconnect
            if (data.state) {
              store.reset();
              for (const artifact of data.state.artifacts ?? []) {
                store.addArtifact(artifact);
              }
              for (const comment of data.state.comments ?? []) {
                store.addComment(comment);
              }
            }
            break;

          case "artifact_created":
            store.addArtifact(data.artifact);
            break;

          case "artifact_updated":
            store.updateArtifact(data.artifactId, data.status);
            break;

          case "comment_added":
            store.addComment(data.comment);
            break;

          case "decision_request":
            // Decision requests come as artifacts — already handled by artifact_created
            notifyIfUnfocused(
              "deepPairing — Decision needed",
              data.context ?? "The agent needs you to choose an approach",
            );
            break;

          case "plan_review_request":
            notifyIfUnfocused(
              "deepPairing — Plan review",
              `Review plan: ${data.title ?? "Implementation plan"}`,
            );
            break;

          case "decision_resolved":
            if (data.artifactId) {
              store.updateArtifact(data.artifactId, "approved");
            }
            break;
        }
      });
    } catch {
      // Ignore malformed messages
    }
  }

  return {
    connected: false,
    sessionId: null,
    ws: null,

    connect: () => {
      const existing = get().ws;
      if (existing && existing.readyState <= 1) return; // Already connected/connecting

      const ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        set({ connected: true, ws });
        // Request notification permission on first connect
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          Notification.requestPermission();
        }
      };

      ws.onmessage = handleMessage;

      ws.onclose = () => {
        set({ connected: false, ws: null });
        // Reconnect after 2 seconds
        setTimeout(() => get().connect(), 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    },

    disconnect: () => {
      const { ws } = get();
      if (ws) {
        ws.close();
        set({ connected: false, ws: null });
      }
    },
  };
});
