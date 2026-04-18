import { create } from "zustand";
import { createAdapter, type ConnectionAdapter } from "../lib/connection-adapter";

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

interface ActiveSession {
  sessionId: string;
  title: string;
  project: string;
  artifactCount: number;
}

interface ConnectionState {
  connected: boolean;
  sessionId: string | null;
  projectRoot: string | null;
  autonomyLevel: "supervised" | "balanced" | "autonomous";
  adapter: ConnectionAdapter | null;
  activeSessions: ActiveSession[];

  connect: (sessionId?: string) => void;
  disconnect: () => void;
  switchSession: (sessionId: string) => void;
  refreshSessions: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => {
  // Expose on window so artifact store can read sessionId without circular import
  const storeRef = { getState: () => get() };
  if (typeof window !== "undefined") (window as any).__dpConnectionStore = storeRef;
  function handleMessage(data: any) {
    // Import artifact store lazily to avoid circular deps
    import("./artifact").then(({ useArtifactStore }) => {
      const store = useArtifactStore.getState();

      switch (data.type) {
        case "connected":
          set({
            sessionId: data.state?.sessionId ?? null,
            projectRoot: data.projectRoot ?? null,
            autonomyLevel: data.state?.autonomyLevel ?? "supervised",
          });
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

        case "artifact_renamed":
          useArtifactStore.setState((s) => ({
            artifacts: s.artifacts.map((a) =>
              a.id === data.artifactId ? { ...a, title: data.title } : a,
            ),
          }));
          break;

        case "decision_request":
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

        case "preference_changed":
          if (data.autonomyLevel) {
            set({ autonomyLevel: data.autonomyLevel });
          }
          break;

        case "decision_resolved":
          if (data.artifactId) {
            store.updateArtifact(data.artifactId, "approved");
          }
          break;

        case "preflight_blocked":
          // The invisible moat made visible — toast so the user SEES
          // that deepPairing just stopped the agent from re-proposing
          // something they'd rejected.
          import("./toast").then(({ useToastStore }) => {
            const match = data.match ?? {};
            const via = match.via === "concept" ? " (concept match)" : "";
            const title = `Memory blocked a repeat proposal${via}`;
            const bodyParts: string[] = [];
            if (match.proposal) bodyParts.push(`"${match.proposal}"`);
            if (match.description && match.description !== match.proposal) {
              bodyParts.push(`previously rejected as "${match.description}"`);
            }
            if (match.reason) bodyParts.push(`— ${match.reason}`);
            useToastStore.getState().push({
              kind: "block",
              title,
              body: bodyParts.join(" "),
              ttl: 8000,
            });
          });
          break;
      }
    });
  }

  return {
    connected: false,
    sessionId: null,
    projectRoot: null,
    autonomyLevel: "supervised",
    adapter: null,
    activeSessions: [],

    connect: (sessionId?: string) => {
      if (get().adapter) return;

      const adapter = createAdapter(undefined, sessionId);
      set({ adapter });

      adapter.onConnect(() => {
        set({ connected: true });
        // Request notification permission on first connect
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          Notification.requestPermission();
        }
      });

      adapter.onMessage(handleMessage);

      adapter.onDisconnect(() => {
        set({ connected: false });
      });

      adapter.connect();
    },

    disconnect: () => {
      const { adapter } = get();
      if (adapter) {
        adapter.disconnect();
        set({ connected: false, adapter: null });
      }
    },

    switchSession: (sessionId: string) => {
      const { adapter } = get();
      if (adapter && "switchSession" in adapter) {
        // Reset artifact store before switching
        import("./artifact").then(({ useArtifactStore }) => {
          useArtifactStore.getState().reset();
        });
        (adapter as any).switchSession(sessionId);
        set({ sessionId });
      }
    },

    refreshSessions: () => {
      fetch(`http://${window.location.host}/api/active-sessions`)
        .then((r) => r.json())
        .then((data) => set({ activeSessions: data.sessions ?? [] }))
        .catch(() => {});
    },
  };
});
