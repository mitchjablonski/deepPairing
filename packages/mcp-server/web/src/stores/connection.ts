import { create } from "zustand";
import { createAdapter, type ConnectionAdapter } from "../lib/connection-adapter";
import { useHookStatusStore } from "./hookStatus";

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
  /** U4 — daemon process identity. A different value across reconnects
   *  means the daemon restarted; we re-hydrate from the new instance and
   *  toast the user so they know any in-flight optimistic updates may
   *  have been lost. */
  daemonStartedAt: string | null;

  connect: (sessionId?: string) => void;
  disconnect: () => void;
  switchSession: (sessionId: string) => void;
  refreshSessions: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => {
  // Expose on window so artifact store can read sessionId without circular import
  const storeRef = { getState: () => get() };
  if (typeof window !== "undefined") (window as any).__dpConnectionStore = storeRef;

  // Q5: last time we surfaced a "feedback received" signal. Debounces the
  // toast during comment bursts so the user who comments on five findings
  // in quick succession sees ONE pair-tempo pip, not five.
  let lastFeedbackToastAt = 0;
  const FEEDBACK_TOAST_DEBOUNCE_MS = 8000;

  function handleMessage(data: any) {
    // Import artifact store lazily to avoid circular deps
    import("./artifact").then(({ useArtifactStore }) => {
      const store = useArtifactStore.getState();

      switch (data.type) {
        case "connected": {
          // U4 — daemon-restart detection. If we've connected before, compare
          // the daemon's startedAt against what we stored. A different value
          // means a NEW daemon process took over the port; in-flight UI state
          // (optimistic mutations the prior daemon never flushed) is now
          // unreachable, and we need to fully rehydrate from the new daemon's
          // store. The toast tells the user so they know to retry anything
          // they thought they'd done in the last few seconds.
          const previousStartedAt = get().daemonStartedAt;
          const newStartedAt: string | null = data.daemonStartedAt ?? null;
          const daemonRestarted =
            previousStartedAt != null &&
            newStartedAt != null &&
            previousStartedAt !== newStartedAt;

          set({
            sessionId: data.state?.sessionId ?? null,
            projectRoot: data.projectRoot ?? null,
            autonomyLevel: data.state?.autonomyLevel ?? "supervised",
            daemonStartedAt: newStartedAt,
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

          if (daemonRestarted) {
            import("./toast").then(({ useToastStore }) => {
              useToastStore.getState().push({
                kind: "info",
                title: "Daemon restarted — session reloaded",
                body: "The deepPairing daemon was restarted. Anything you submitted in the last few seconds may need to be retried.",
                ttl: 8000,
              });
            });
          }
          break;
        }

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

        case "feedback_received":
          // Q5: synthetic "I see you" signal. The server acknowledges
          // receipt of a human comment; the agent won't actually see it
          // until its next check_feedback poll, but the user gets immediate
          // pair-tempo feedback that their message entered the session.
          // Debounced so a burst of comments doesn't spam the toast queue.
          {
            const now = Date.now();
            if (now - lastFeedbackToastAt < FEEDBACK_TOAST_DEBOUNCE_MS) break;
            lastFeedbackToastAt = now;
            import("./toast").then(({ useToastStore }) => {
              useToastStore.getState().push({
                kind: "info",
                title: "✓ Sent — Claude will see this on its next check",
                body: "check_feedback polls every ~30s while Claude is working.",
                ttl: 4000,
              });
            });
          }
          break;

        case "preflight_blocked":
          // O2: the rejection-block hero toast. This is THE distinctive
          // deepPairing moment — the UI treats it as such.
          import("./toast").then(({ useToastStore }) => {
            const match = data.match ?? {};
            const source: "session" | "team" = data.source === "team" ? "team" : "session";
            const title = source === "team"
              ? "Blocked by team policy"
              : "Blocked by your taste";
            useToastStore.getState().push({
              kind: "preflight-block",
              title,
              // body not used for preflight-block; render from hero
              hero: {
                source,
                concept: match.concept ?? match.description ?? "this approach",
                proposal: match.proposal,
                reason: match.reason,
                via: match.via ?? "surface",
                addedBy: match.addedBy,
                rejectedAt: match.rejectedAt,
                projectCount: match.projectCount,
              },
              ttl: 12000,
              action: {
                label: "Open Your taste",
                onClick: () => window.dispatchEvent(new CustomEvent("dp:open-your-taste")),
              },
            });
          });
          break;

        case "ledger_write":
          // O7: taste compounds as the user works — surface each write so
          // the Philosophy Ledger stops being "visible on demand" and
          // becomes felt in the moment it grows.
          import("./toast").then(({ useToastStore }) => {
            const kind = data.kind === "approved" ? "approved" : "rejected";
            const desc = String(data.description ?? "this approach");
            const trimmed = desc.length > 60 ? desc.slice(0, 57) + "…" : desc;
            const icon = kind === "approved" ? "+ prefer" : "+ avoid";
            useToastStore.getState().push({
              kind: "info",
              title: `🧭 Added to Your taste: ${icon}`,
              body: `"${trimmed}"`,
              ttl: 5000,
              action: {
                label: "Open Your taste",
                onClick: () => window.dispatchEvent(new CustomEvent("dp:open-your-taste")),
              },
            });
          });
          break;

        case "question_answered":
          // O7: link the user back to their question so a flurry of comment
          // threads doesn't bury the one reply they were waiting on.
          import("./toast").then(({ useToastStore }) => {
            const excerpt = String(data.answerExcerpt ?? "").trim();
            const body = excerpt ? `"${excerpt}${excerpt.length >= 120 ? "…" : ""}"` : undefined;
            const artifactId = data.artifactId;
            useToastStore.getState().push({
              kind: "success",
              title: "❓→✓ Your question was answered",
              body,
              ttl: 6000,
              action: artifactId
                ? {
                    label: "Jump to answer",
                    onClick: () =>
                      window.dispatchEvent(
                        new CustomEvent("dp:focus-artifact", { detail: { artifactId } }),
                      ),
                  }
                : undefined,
            });
          });
          break;

        case "preflight_trace_recorded":
          // Y1' — bridge the WS event to a window CustomEvent so the
          // PreflightBreadcrumb component (mounted per-artifact) can
          // pick it up without subscribing to the whole connection store.
          if (data.artifactId && data.trace) {
            window.dispatchEvent(
              new CustomEvent("dp:preflight-trace", {
                detail: { artifactId: data.artifactId, trace: data.trace },
              }),
            );
          }
          break;

        case "hook_fired":
          // X7 — every Stop / Checkpoint hook fire (pass or nag) is broadcast
          // by the daemon's file watcher. Push into the dedicated store so
          // <HookStatus> can render without an HTTP roundtrip per fire.
          if (data.fire) {
            useHookStatusStore.getState().pushFire(data.fire);
          }
          break;

        case "decision_resolved_hero":
          // O7: captured prediction doesn't disappear into the decision
          // record — it's a calibration moment worth pinning for a few
          // seconds.
          import("./toast").then(({ useToastStore }) => {
            const chosen = String(data.chosenTitle ?? "");
            const predicted = String(data.predictedOutcome ?? "").trim();
            const confidence = data.confidence ? ` (${data.confidence} confidence)` : "";
            useToastStore.getState().push({
              kind: "success",
              title: `✅ Chose ${chosen}`,
              body: predicted ? `Prediction captured: "${predicted}"${confidence}` : undefined,
              ttl: 7000,
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
    daemonStartedAt: null,

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
        // X7: hydrate hook fire history once. Subsequent fires arrive via
        // the `hook_fired` broadcast handler; load() is idempotent enough
        // to call again on reconnect, so we don't gate it on `loaded`.
        useHookStatusStore.getState().load();
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
