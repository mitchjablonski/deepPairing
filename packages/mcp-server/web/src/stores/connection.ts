import { create } from "zustand";
import { createAdapter, type ConnectionAdapter } from "../lib/connection-adapter";
import { apiGet, sessionHeaders, apiBase } from "../lib/api";
import { useHookStatusStore } from "./hookStatus";
import { isDraftAwaitingReview } from "../lib/pending";

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
  /** D8 (M8) — wrapper still registered on the daemon. Optional: old daemons omit it. */
  live?: boolean;
}

interface ConnectionState {
  connected: boolean;
  /** D8 (H4) — epoch ms of the FIRST disconnect of the current outage; null while connected. */
  disconnectedSince: number | null;
  sessionId: string | null;
  projectRoot: string | null;
  /**
   * AA4 — short deterministic identity for projectRoot, advertised by the
   * daemon on /api/daemon-info + the WS `connected` event. sessionHeaders()
   * (lib/api.ts) sends it as `X-Project-Hash` on every mutation; the
   * daemon 403s with project_hash_mismatch if its own hash differs.
   * Closes the stale-tab-after-port-recycling write hole.
   */
  projectHash: string | null;
  autonomyLevel: "supervised" | "balanced" | "autonomous";
  adapter: ConnectionAdapter | null;
  activeSessions: ActiveSession[];
  /** U4 — daemon process identity. A different value across reconnects
   *  means the daemon restarted; we re-hydrate from the new instance and
   *  toast the user so they know any in-flight optimistic updates may
   *  have been lost. */
  daemonStartedAt: string | null;
  /** B2 — ms timestamp of the last `agent_activity` heartbeat (the daemon
   *  broadcasts one, throttled, on every internal API call the agent's
   *  wrapper makes). Honest liveness — unlike artifact timestamps, it keeps
   *  ticking during a long edit run between tool calls. */
  agentActivityAt: number | null;
  /** B2 — start of the current activity streak (a gap >60s starts a new
   *  one). Drives the "Agent working · Nm" elapsed label. */
  agentActiveSince: number | null;
  /** C5 — true once the first `connected` payload has been processed: we KNOW
   *  whether this daemon has sessions/artifacts. Until then App shows a
   *  skeleton instead of flashing IdleHome/WaitingForClaude on every refresh
   *  (the app impersonating its own cold start). */
  hydrated: boolean;

  connect: (sessionId?: string) => void;
  disconnect: () => void;
  switchSession: (sessionId: string) => void;
  refreshSessions: () => void;
  /** MP1 — repoint the whole SPA at another project's daemon (host:port). */
  switchProject: (host: string) => Promise<void>;
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

  // B2 — draft-notification dedupe + burst suppression. Dedupe is by ARTIFACT
  // ID (not event type): in daemon mode the MCP-side broadcast is a no-op, so
  // decision_request/plan_review_request never reach the browser and drafts
  // arrive only as artifact_created — but in standalone/test wiring BOTH can
  // fire for the same artifact, and the id-set collapses them. The 5s burst
  // window keeps an agent presenting several artifacts back-to-back (or a
  // supersede re-broadcast) from firing N OS notifications — the tab-title
  // badge carries the true count.
  const notifiedArtifactIds = new Set<string>();
  let lastDraftNotifyAt = 0;
  const notifyDraft = (artifactId: string | undefined, body: string) => {
    if (artifactId) {
      if (notifiedArtifactIds.has(artifactId)) return;
      notifiedArtifactIds.add(artifactId);
    }
    const now = Date.now();
    if (now - lastDraftNotifyAt < 5_000) return;
    lastDraftNotifyAt = now;
    notifyIfUnfocused("deepPairing — your turn", body);
  };

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

          // AA4 — when the daemon process changed, the OLD sessionId is
          // meaningless to the new daemon. Pre-AA4 we kept it cached in
          // the store; sessionHeaders() then sent the stale id on the
          // next mutation. Now: drop the cached sid on a detected
          // restart and let the daemon's new state.sessionId (if any)
          // become authoritative. Belt-and-suspenders alongside the
          // X-Project-Hash check on the daemon side.
          const inboundSid = data.state?.sessionId ?? null;
          const sessionId = daemonRestarted
            ? inboundSid // discard stale local sid; trust the new daemon
            : (inboundSid ?? get().sessionId);

          set({
            sessionId,
            projectRoot: data.projectRoot ?? null,
            // AA4 — capture the daemon's projectHash so api.ts can echo
            // it on every mutation as X-Project-Hash.
            projectHash: data.projectHash ?? null,
            autonomyLevel: data.state?.autonomyLevel ?? "supervised",
            daemonStartedAt: newStartedAt,
          });

          // HH1 — close the GG2 regression. The first WS upgrade
          // happened BEFORE projectHash was known, so the URL was
          // built without it and the daemon accepted on back-compat.
          // Now that the hash has arrived, ask the adapter to rebuild
          // its URL with the hash appended and reconnect — the next
          // upgrade carries the gate parameter the daemon expects.
          // Idempotent: refreshUrl is a no-op when the URL hasn't
          // changed, so this doesn't flap on subsequent connected
          // events that carry the same hash.
          const adapter = get().adapter;
          if (adapter?.refreshUrl) adapter.refreshUrl();

          // Reset before hydration to prevent duplicates on reconnect
          if (data.state) {
            store.reset();
            for (const artifact of data.state.artifacts ?? []) {
              store.addArtifact(artifact);
            }
            for (const comment of data.state.comments ?? []) {
              store.addComment(comment);
            }
            // C2 — receipts survive reload: the DecisionRecord's persisted
            // `acknowledged` flag re-seeds the consumed set on hydration.
            const ackedIds = (data.state.decisions ?? [])
              .filter((d: any) => d?.acknowledged && d?.decisionId)
              .map((d: any) => d.decisionId as string);
            if (ackedIds.length > 0) store.markDecisionsAcknowledged(ackedIds);
            // QOL — return to the artifact you were last on, now that the
            // session has hydrated (overrides addArtifact's first-artifact pick).
            store.restoreSelection();
          }

          set({ hydrated: true });

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
          // B2 — the turn-handoff has to reach a BACKGROUNDED tab for EVERY
          // reviewable draft. Pre-B2 only decision_request/plan_review_request
          // notified — and in daemon mode (the only production wiring) the
          // MCP-side broadcast of those is a NO-OP, so in practice NOTHING
          // notified. artifact_created is the daemon-broadcast event every
          // draft flows through, so it's the one honest trigger; notifyDraft
          // dedupes by artifact id against the dedicated events below (which
          // still fire in standalone/test wiring).
          if (data.artifact && isDraftAwaitingReview(data.artifact)) {
            const label =
              {
                decision: "Decision needed",
                plan: "Plan ready for review",
                code_change: "Code change ready for review",
                spec: "Spec ready for review",
                research: "Findings ready for review",
              }[data.artifact.type as string] ?? "Ready for review";
            notifyDraft(data.artifact.id, `${label}: ${data.artifact.title ?? ""}`);
          }
          break;

        case "decisions_acknowledged":
          // C2 — the agent consumed these resolutions (check_feedback ack).
          if (Array.isArray(data.decisionIds)) {
            store.markDecisionsAcknowledged(data.decisionIds);
          }
          break;

        case "agent_activity": {
          // B2 — throttled heartbeat from the daemon on every internal API
          // call the agent's wrapper makes. A gap >60s starts a new activity
          // streak (check_feedback polls ~30s, so a live agent pings at least
          // that often); agentActiveSince drives "Agent working · Nm".
          const now = Date.now();
          const prev = get().agentActivityAt;
          set({
            agentActivityAt: now,
            agentActiveSince:
              prev !== null && now - prev < 60_000 ? (get().agentActiveSince ?? now) : now,
          });
          break;
        }

        case "artifact_updated":
          store.updateArtifact(data.artifactId, data.status);
          break;

        case "plan_progress_updated":
          // D10 (H2) — full-artifact patch: step statuses live in content.
          useArtifactStore.getState().replaceArtifact(data.artifact);
          break;

        case "comment_added":
          store.addComment(data.comment);
          break;

        case "comment_updated":
          store.updateComment(data.comment);
          break;

        case "artifact_renamed":
          useArtifactStore.setState((s) => ({
            artifacts: s.artifacts.map((a) =>
              a.id === data.artifactId ? { ...a, title: data.title } : a,
            ),
          }));
          break;

        // B2 — these only reach the browser in standalone/test wiring (the
        // daemon-mode MCP broadcast is a no-op); artifact_created above is the
        // production trigger. Routed through notifyDraft so the same artifact
        // can't notify twice when both events DO fire.
        case "decision_request":
          notifyDraft(
            data.artifactId,
            `Decision needed: ${data.context ?? "the agent needs you to choose an approach"}`,
          );
          break;

        case "plan_review_request":
          notifyDraft(data.artifactId, `Plan ready for review: ${data.title ?? "Implementation plan"}`);
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
                body: "Claude checks in about every 30 seconds while working.",
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
                description: match.description,
                proposal: match.proposal,
                reason: match.reason,
                via: match.via ?? "surface",
                addedBy: match.addedBy,
                rejectedAt: match.rejectedAt,
                projectCount: match.projectCount,
              },
              ttl: 12000,
              action: {
                label: "Open the Ledger",
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
              title: `🧭 Added to your Ledger: ${icon}`,
              body: `"${trimmed}"`,
              ttl: 5000,
              action: {
                label: "Open the Ledger",
                onClick: () => window.dispatchEvent(new CustomEvent("dp:open-your-taste")),
              },
            });
          });
          break;

        case "stance_overridden":
          // A taste stance was scoped down (override of a false-positive block).
          // The acting tab already toasted its own confirmation; here we just
          // keep OTHER tabs' ledger view consistent by refreshing the digest.
          import("./ledger").then(({ useLedgerStore }) => {
            void useLedgerStore.getState().refetch();
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

        case "daemon_resumed":
          // AA2 — wrapper auto-recovered from a 404 session_not_registered
          // (daemon restarted while the wrapper was alive). The WS kept
          // streaming on the same socket so the browser never knew its
          // optimistic state may be stale; the daemon broadcasts this so
          // we can refetch full state + toast the user.
          fetch(`${apiBase()}/api/state`, {
            headers: { ...sessionHeaders(), "X-Session-Id": data.sessionId ?? get().sessionId ?? "" },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((fresh) => {
              if (!fresh) return;
              store.reset();
              for (const artifact of fresh.artifacts ?? []) store.addArtifact(artifact);
              for (const comment of fresh.comments ?? []) store.addComment(comment);
            })
            .catch(() => {});
          import("./toast").then(({ useToastStore }) => {
            useToastStore.getState().push({
              kind: "info",
              title: "Daemon recovered — session state refetched",
              body: "The deepPairing daemon restarted; the wrapper auto-re-registered. Anything you submitted in the last few seconds may need to be retried.",
              ttl: 8000,
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

        case "daemon_evicting":
          // BB9 — AA3's /api/evict route broadcasts this to every connected
          // tab when another project's `doctor --fix` cooperatively shuts
          // the daemon down (cross-project port collision). Pre-BB9 the
          // browser silently lost its WS — no banner, no explanation, the
          // user's tab just stopped receiving updates while their session
          // was still on screen. Now we push a destructive toast so the
          // user knows to close the tab or restart Claude Code in this
          // project. Setting connected=false stops the optimistic-state
          // feedback loop.
          import("./toast").then(({ useToastStore }) => {
            const otherProject = typeof data.projectRoot === "string" ? data.projectRoot : "another project";
            useToastStore.getState().push({
              kind: "error",
              title: "Daemon shut down",
              body: `${otherProject}'s doctor evicted the daemon to claim this port. Close this tab or restart Claude Code in this project to reconnect.`,
              ttl: 0,
            });
          });
          set({ connected: false });
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
    disconnectedSince: null,
    sessionId: null,
    projectRoot: null,
    agentActivityAt: null,
    agentActiveSince: null,
    hydrated: false,
    // II2.2 — seed projectHash from the daemon's HTML injection
    // (window.__dpProjectHash) so the VERY FIRST WS connect URL and mutation
    // fetch carry X-Project-Hash. Otherwise the fail-closed gate 403s the
    // first WS upgrade, the `connected` payload that would populate this
    // never arrives, and the tab is deadlocked. The WS `connected` handler
    // still overwrites this if the daemon reports a different hash.
    projectHash:
      typeof window !== "undefined" && typeof (window as any).__dpProjectHash === "string"
        ? (window as any).__dpProjectHash
        : null,
    autonomyLevel: "supervised",
    adapter: null,
    activeSessions: [],
    daemonStartedAt: null,

    connect: (sessionId?: string) => {
      if (get().adapter) return;

      const adapter = createAdapter(undefined, sessionId);
      set({ adapter });

      adapter.onConnect(() => {
        set({ connected: true, disconnectedSince: null });
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
        // D8 (H4) — stamp WHEN the outage started (first flip only) so the
        // banner can escalate: a 30-second blip and a dead daemon looked
        // identical forever.
        set((st) => ({
          connected: false,
          disconnectedSince: st.disconnectedSince ?? Date.now(),
        }));
      });

      // II3 — the WS adapter detected (via /api/daemon-info) that the
      // daemon on this port now serves a DIFFERENT project than the one
      // this tab is bound to. Pre-II3 the adapter silently rebound the
      // tab to the live daemon's hash — switching the tab to another
      // project so comments/approvals could land in the wrong place.
      // Now it stops the reconnect loop and fires this; we surface a
      // sticky "reload to re-bind" toast mirroring the BB10 REST-side
      // guard (see stores/artifact.ts toastApiError). Reload is the only
      // safe recovery: it refetches the live daemon's hash and rebinds
      // the tab deliberately.
      adapter.onFatalMismatch?.(() => {
        set({ connected: false });
        import("./toast").then(({ useToastStore }) => {
          useToastStore.getState().push({
            kind: "error",
            title: "Tab is bound to a stale daemon",
            body: "This project's daemon was replaced by a different project's daemon on the same port. Reload the page to re-bind.",
            ttl: 0,
            action: {
              label: "Reload to re-bind",
              onClick: () => {
                if (typeof window !== "undefined") window.location.reload();
              },
            },
          });
        });
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
        // B2 — drop the OLD session's heartbeat streak, or the TurnIndicator
        // shows "Agent working · Nm" from session A for up to 45s on session B.
        set({ sessionId, agentActivityAt: null, agentActiveSince: null });
      }
    },

    refreshSessions: () => {
      // MP1 — use the switchable base so this reflects the SELECTED project.
      apiGet(`${apiBase()}/api/active-sessions`)
        .then((r) => r.json())
        .then((data) => {
          const next: ActiveSession[] = data.sessions ?? [];
          // D6 (P1) — equality bail. An unconditional set minted a new array
          // identity every 10s poll, re-rendering the ENTIRE App subtree at
          // idle. Compare ALL FOUR rendered fields (id alone would freeze the
          // session bar's title / artifact-count badges).
          const prev = get().activeSessions;
          const same =
            prev.length === next.length &&
            prev.every((p, i) => {
              const n = next[i];
              return (
                p.sessionId === n.sessionId &&
                p.title === n.title &&
                p.project === n.project &&
                p.artifactCount === n.artifactCount &&
                // D8 — every RENDERED field must be here (D6 review's drift
                // warning); live drives the session-bar dot.
                p.live === n.live
              );
            });
          if (!same) set({ activeSessions: next });
        })
        .catch(() => {});
    },

    // MP1 (multi-project spike) — repoint the entire SPA at another project's
    // daemon (a different localhost port). Tears down the current connection,
    // switches the shared base, re-seeds projectHash from the target daemon's
    // /api/daemon-info, clears the artifact store, and reconnects. Cross-origin
    // flows no longer exist post-D5 — this navigates instead.
    switchProject: async (host: string) => {
      // D5 — FULL NAVIGATION, not in-page repointing. The target daemon
      // serves its own HTML with ITS bearer token + projectHash injected.
      // The old in-page switch left the tab holding daemon A's token against
      // daemon B: reads only worked because reads were origin-open (the
      // exposure D5 closes), and bearer-gated mutations were silently
      // 401ing already. Navigation makes every flow same-origin again.
      if (typeof window !== "undefined") {
        window.location.assign(`http://${host}/`);
      }
    },
  };
});
