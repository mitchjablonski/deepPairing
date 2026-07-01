import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiBase } from "./lib/api";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { IdleHome } from "./components/IdleHome";
import { WaitingForClaude } from "./components/WaitingForClaude";
import { TurnIndicator } from "./components/TurnIndicator";
import { PendingBanner } from "./components/PendingBanner";
import { KeyboardShortcutHelp } from "./components/KeyboardShortcutHelp";
import { MessageInput } from "./components/MessageInput";
import { AutonomySlider } from "./components/AutonomySlider";
import { CompoundingBadge } from "./components/CompoundingBadge";
import { CommandPalette } from "./components/CommandPalette";
import { QuickAskModal } from "./components/QuickAskModal";
import { SettingsSheet } from "./components/SettingsSheet";
import { ReplayScrubber } from "./components/ReplayScrubber";
import { ToastLayer } from "./components/ToastLayer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { YourTasteDrawer } from "./components/YourTasteDrawer";
import { ConversationRail } from "./components/ConversationRail";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { SkillLoadBanner } from "./components/SkillLoadBanner";
import { HookStatus } from "./components/HookStatus";
import { useArtifactStore } from "./stores/artifact";
import { useConnectionStore } from "./stores/connection";
import { scrollToAnchor } from "./lib/comment-anchor";
import { countUnansweredQuestions } from "./lib/unanswered";
import { useOverlayStore } from "./stores/overlay";
import { usePreloadErrorReload } from "./hooks/usePreloadErrorReload";
import { usePollingWhenVisible } from "./hooks/usePollingWhenVisible";

function App() {
  const { connected, connect, sessionId, activeSessions, switchSession, refreshSessions } = useConnectionStore();
  const hasArtifacts = useArtifactStore((s) => s.artifacts.length > 0);

  // U7 — at-rest signal on the Conversation button: how many human questions
  // are still awaiting the agent. Uses the SHARED predicate (lib/unanswered)
  // that ConversationRail's pill/filter/marker use, so the badge can't drift
  // from the rail. Without it the cross-artifact triage surface gave no hint.
  const comments = useArtifactStore((s) => s.comments);
  const unansweredCount = useMemo(
    () => countUnansweredQuestions(Object.values(comments).flat()),
    [comments],
  );
  const [showHelp, setShowHelp] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTaste, setShowTaste] = useState(false);
  // BB6 — when a PreflightBreadcrumb concept is clicked, open the drawer
  // straight to the ledger tab and highlight the matching row. Cleared on
  // close so a fresh open from the header button shows the default tab.
  const [tasteOpts, setTasteOpts] = useState<{ initialTab?: "ledger"; highlightConcept?: string }>({});
  // CC9 — single close callback so tasteOpts is reset on EVERY close
  // path (Esc, backdrop, drawer's own onClose). Pre-CC9 the Esc path at
  // line ~99 only flipped showTaste=false without clearing tasteOpts;
  // a subsequent reopen via the header button would render with the
  // stale highlight ring/initialTab from the previous deep-link.
  const closeTaste = () => {
    setShowTaste(false);
    setTasteOpts({});
  };
  // W1 — conversation rail visibility. Wired the same way as showTaste:
  // header button toggles, dp:open-conversation event lets toasts open it,
  // Esc closes via the drawer's own keydown.
  const [showConversation, setShowConversation] = useState(false);
  // U3 — themed "ask about this artifact" composer for the `q` shortcut.
  const [askArtifact, setAskArtifact] = useState<{ id: string; title: string } | null>(null);

  // UX4 — the global keydown handler is registered once (stable []), so it reads
  // "is any overlay open?" through this ref. While an overlay is open the
  // artifact shortcuts (j/k/a/r/q) must NOT act on the obscured artifact behind
  // it (e.g. `a` arming an approve on a hidden artifact). overlayCount covers
  // component-internal modals App can't see (FileViewer/RepairDecisionModal/
  // HookStatus) via the overlay-presence store; the booleans cover App-owned
  // overlays. Assigned in render (not an effect) so it's never a frame stale.
  // UM — every overlay now reports through useOverlayStore (via useModal /
  // useOverlayPresence), so the store count is the single source of truth. The
  // old hand-list (`showHelp || showPalette || …`) is gone — a new overlay can
  // no longer silently fail to suppress shortcuts by being forgotten here.
  const overlayCount = useOverlayStore((s) => s.count);
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current = overlayCount > 0;

  // Mermaid resilience — sticky "reload" prompt when a lazy chunk fails to load
  // (daemon rebuilt/restarted → stale tab). See the hook for details.
  usePreloadErrorReload();

  // Fetch active sessions on mount, auto-connect to the first one (or to the
  // session named in ?session=... — used by `npx deeppairing demo` to land
  // the user directly on the demo session).
  useEffect(() => {
    const init = async () => {
      refreshSessions();
      const requested = new URLSearchParams(window.location.search).get("session");
      try {
        const res = await apiGet(`${apiBase()}/api/active-sessions`);
        const data = await res.json();
        const sessions = data.sessions ?? [];
        if (requested && sessions.some((s: any) => s.sessionId === requested)) {
          connect(requested);
        } else if (sessions.length > 0) {
          connect(sessions[0].sessionId);
        } else {
          connect(); // Fallback: global connection
        }
      } catch {
        connect();
      }
    };
    init();
  }, []);

  // PP3 — poll for new sessions only while the tab is visible AND connected
  // (was a bare 10s setInterval that fired forever, even hidden/disconnected).
  usePollingWhenVisible(refreshSessions, 10000, connected);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip ALL shortcuts when the user is typing in an editable surface.
      // Belt + suspenders: tag names cover <input>/<textarea>/<select>;
      // contenteditable covers rich-text or CodeMirror-style editors.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable === true
      ) return;

      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setShowPalette((v) => !v);
        return;
      }
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setShowSettings((v) => !v);
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
      if (e.key === "Escape") {
        setShowHelp(false);
        setShowPalette(false);
        setShowSettings(false);
        closeTaste(); // CC9 — also clears tasteOpts
        setShowConversation(false);
      }

      // UX4 — beyond this point are the ARTIFACT shortcuts (j/k/a/r/q). Suppress
      // them while an overlay/drawer is open (the toggles + Escape above still
      // work) so they don't drive the artifact hidden behind it.
      if (overlayOpenRef.current) return;

      const store = useArtifactStore.getState();

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const visible = store.artifacts.filter((a) => a.status !== "superseded");
        if (visible.length === 0) return;
        const currentIdx = visible.findIndex((a) => a.id === store.selectedArtifactId);
        const nextIdx = e.key === "j"
          ? Math.min(currentIdx + 1, visible.length - 1)
          : Math.max(currentIdx - 1, 0);
        store.selectArtifact(visible[nextIdx].id);
      }

      if (e.key === "a" || e.key === "r") {
        const selected = store.artifacts.find((a) => a.id === store.selectedArtifactId);
        if (!selected || selected.status !== "draft") return;
        e.preventDefault();
        // Dispatch to the active artifact's action panel. The panel arms a
        // confirm affordance (countdown for approve, focus the comment
        // textarea for revise) — never commits silently on a single keystroke.
        window.dispatchEvent(
          new CustomEvent("dp:artifact-shortcut", {
            detail: { artifactId: selected.id, action: e.key === "a" ? "approve" : "revise" },
          }),
        );
      }

      if (e.key === "q") {
        const selected = store.artifacts.find((a) => a.id === store.selectedArtifactId);
        if (!selected) return;
        e.preventDefault();
        // U3 — open the themed ask composer (setter is referentially stable).
        // Was window.prompt, a no-op inside the VS Code webview that embeds this
        // UI (and a jarring native dialog in the browser).
        setAskArtifact({ id: selected.id, title: selected.title });
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // O2: the PreflightBlockToast action dispatches this event to open the
  // Your Taste drawer. Decoupled so the toast doesn't need a ref to App state.
  // BB6 — also accepts { initialTab, highlightConcept } in detail so the
  // PreflightBreadcrumb's "Considered:" rows can deep-link into the ledger.
  useEffect(() => {
    const openTaste = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { initialTab?: "ledger"; highlightConcept?: string }
        | undefined;
      setTasteOpts(detail ?? {});
      setShowTaste(true);
    };
    window.addEventListener("dp:open-your-taste", openTaste);
    return () => window.removeEventListener("dp:open-your-taste", openTaste);
  }, []);

  // W1: same decoupling for the conversation rail. Toasts (or future
  // surfaces) can open it via window.dispatchEvent(new CustomEvent("dp:open-conversation")).
  useEffect(() => {
    const openConv = () => setShowConversation(true);
    window.addEventListener("dp:open-conversation", openConv);
    return () => window.removeEventListener("dp:open-conversation", openConv);
  }, []);

  // O7: question-answered toast's "Jump to answer" action selects the
  // artifact the answer belongs to, scrolling it into view.
  // X10: when the dispatcher carries a comment anchor (filePath+line, step,
  // or finding), follow up with a scroll-to-anchor on the next tick so the
  // artifact has rendered before we query the DOM.
  useEffect(() => {
    const focus = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { artifactId?: string; anchorKey?: string }
        | undefined;
      if (!detail?.artifactId) return;
      useArtifactStore.getState().selectArtifact(detail.artifactId);
      if (detail.anchorKey) {
        // requestAnimationFrame waits one paint — usually enough for the
        // artifact panel to swap. If the element still isn't there, try
        // a couple more times before giving up; the artifact may be
        // mounting async (suspense, dynamic imports, etc.).
        const tryScroll = (retries: number) => {
          if (scrollToAnchor(detail.artifactId!, detail.anchorKey!)) return;
          if (retries > 0) requestAnimationFrame(() => tryScroll(retries - 1));
        };
        requestAnimationFrame(() => tryScroll(2));
      }
    };
    window.addEventListener("dp:focus-artifact", focus);
    return () => window.removeEventListener("dp:focus-artifact", focus);
  }, []);

  return (
    <div className="h-screen bg-surface-primary text-text-primary flex flex-col">
      {/* O6: surfaces when the pairing-protocol skill isn't active so the
          plugin-install path doesn't fail silently. Dismissible; auto-hides
          once any artifact arrives. */}
      <SkillLoadBanner />

      {/* Header — pared back to the essentials. Low-frequency chrome
          (theme, font size, content width, editor picker, export) lives in
          the Settings sheet (⌘,). Quick actions live in the Command palette (⌘K). */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-default bg-surface-secondary">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-bold shrink-0">deepPairing</h1>
          <ProjectSwitcher />
          <TurnIndicator />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <CompoundingBadge onOpen={() => window.dispatchEvent(new CustomEvent("dp:open-your-taste"))} />
          <AutonomySlider />
          <span className="text-2xs text-text-muted mx-1">·</span>
          <button
            onClick={() => {
              // CC3 — when the user is on the cold-start IdleHome (no
              // artifacts yet), the home view's primary tab is already
              // the ledger. The header button used to land on the
              // "Stances" tab instead — so clicking the most ledger-
              // shaped affordance during idle took users to a different
              // surface than the one they were already looking at. Now
              // the button respects the surface the user came from:
              // idle → ledger tab, mid-session → default (stances).
              setTasteOpts(hasArtifacts ? {} : { initialTab: "ledger" });
              setShowTaste(true);
            }}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Your cross-project taste from the Philosophy Ledger"
            aria-label="Open Your Taste drawer"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
              <path d="M6 1.5c2.5 0 4.5 2 4.5 4.5 0 1.5-.8 2.8-2 3.5" />
              <circle cx="6" cy="9.5" r="1" fill="currentColor" />
              <path d="M6 1.5v2M1.5 6h2M10.5 6h-2" />
            </svg>
            <span className="hidden min-[700px]:inline">Your taste</span>
          </button>
          <span className="text-2xs text-text-muted mx-1">·</span>
          <button
            onClick={() => setShowConversation(true)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Conversation — every comment + reply across artifacts"
            aria-label="Open conversation rail"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3.5h8v4H6.5L4.5 9.5V7.5H2V3.5Z" />
            </svg>
            <span className="hidden min-[700px]:inline">Conversation</span>
            {unansweredCount > 0 && (
              <span
                className="ml-0.5 min-w-[15px] h-[15px] px-1 inline-flex items-center justify-center rounded-full bg-accent-blue text-white text-[9px] font-semibold leading-none"
                aria-label={`${unansweredCount} unanswered question${unansweredCount === 1 ? "" : "s"}`}
              >
                {unansweredCount}
              </span>
            )}
          </button>
          <span className="text-2xs text-text-muted mx-1">·</span>
          <HookStatus />
          <span className="text-2xs text-text-muted mx-1">·</span>
          <button
            onClick={() => setShowPalette(true)}
            className="hidden min-[700px]:inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Command palette (⌘K)"
          >
            <span>Search</span>
            <kbd className="font-mono bg-surface-elevated px-1 rounded text-[9px]">⌘K</kbd>
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-secondary transition-colors"
            title="Settings (⌘,)"
            aria-label="Open settings"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
              <circle cx="7" cy="7" r="2" />
              <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.8 2.8l1.4 1.4M9.8 9.8l1.4 1.4M2.8 11.2l1.4-1.4M9.8 4.2l1.4-1.4" />
            </svg>
          </button>
          <button
            onClick={() => setShowHelp(true)}
            className="px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Keyboard shortcuts (?)"
            aria-label="Show keyboard shortcuts"
          >
            <kbd className="font-mono">?</kbd>
          </button>
        </div>
      </div>

      {/* Session bar — always visible */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-default bg-surface-secondary overflow-x-auto shrink-0">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" className="shrink-0 text-text-muted mr-0.5">
          <rect x="1" y="2" width="4" height="3.5" rx="0.5" />
          <rect x="7" y="2" width="4" height="3.5" rx="0.5" />
          <rect x="1" y="7" width="4" height="3" rx="0.5" />
          <rect x="7" y="7" width="4" height="3" rx="0.5" />
        </svg>
        {activeSessions.length === 0 ? (
          <span className="text-2xs text-text-muted">No active sessions — start a Claude Code conversation with deepPairing</span>
        ) : (
          activeSessions.map((s, i) => {
            const isActive = sessionId === s.sessionId;
            const label = s.title && s.title !== s.sessionId
              ? s.title
              : s.project
                ? s.project
                : `Session ${i + 1}`;
            return (
              <button
                key={s.sessionId}
                onClick={() => switchSession(s.sessionId)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-2xs transition-all duration-[180ms] shrink-0 press-scale ${
                  isActive
                    ? "bg-accent-blue-dim text-accent-blue font-medium border border-accent-blue/20"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface-hover border border-transparent"
                }`}
                title={`${s.sessionId}${s.project ? `\nProject: ${s.project}` : ""}\nArtifacts: ${s.artifactCount}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-accent-blue animate-pulse" : "bg-accent-green"}`} />
                <span className="truncate max-w-40">{label}</span>
                {s.artifactCount > 0 && (
                  <span className="text-[9px] bg-surface-elevated px-1 py-0.5 rounded opacity-70">{s.artifactCount}</span>
                )}
              </button>
            );
          })
        )}
      </div>

      {/* Disconnected warning */}
      {!connected && (
        <div className="px-3 py-1.5 bg-accent-red-dim/30 border-b border-accent-red/15 text-center">
          <span className="text-2xs text-accent-red">
            Disconnected from server — reconnecting...
          </span>
        </div>
      )}

      {/* Replay scrubber — only renders when replay mode is active */}
      <ReplayScrubber />

      {/* O3: the sticky "Accept All" ReviewGate is gone — it read as
          autonomous-agent chrome, not pairing. Bulk approve still lives in
          the Command palette for keyboard users who want it. The per-artifact
          review happens inside ArtifactStatusActions. */}
      {/* Pending decision/plan banner */}
      <PendingBanner />

      {/* Main content.
          III10 — when the WS is connected but no wrapper has registered a
          session, render WaitingForClaude (with explicit project root +
          "try this" hint) instead of IdleHome's empty Ledger panel.
          Pre-III10 a fresh-install user who ran `init` but hadn't yet
          launched Claude saw an empty "Your Ledger" panel with zero
          entries and no indication that the agent wasn't connected.
          The session bar's "No active sessions" hint was below threshold.
          Now the main surface is a directed "do this next" affordance. */}
      {/* IV9 — demo session "next step" CTA. When the active session is
          a scripted demo (sessionId starts with `demo_` per daemon.ts:407),
          surface a one-line card pointing the user at the Claude Code
          plugin install command. The demo fires the rejection-block toast
          in ~5s and then leaves the user with a populated companion UI
          but no obvious "what's next." This card closes the loop. Only
          renders when a demo session is active AND has at least one
          artifact — i.e., the demo has actually fired. */}
      {connected && sessionId?.startsWith("demo_") && hasArtifacts && (
        <div className="px-3 py-2 bg-accent-blue-dim/30 border-b border-accent-blue/20 text-2xs flex items-center gap-2 shrink-0">
          <span className="text-accent-blue font-medium">✓ Demo fired.</span>
          <span className="text-text-secondary">Next: connect Claude Code in your real project →</span>
          <code className="bg-surface-elevated px-1.5 py-0.5 rounded text-text-primary font-mono">
            claude --plugin-dir /path/to/deeppairing/claude-plugin
          </code>
        </div>
      )}

      <div className="flex-1 min-h-0">
        <ErrorBoundary fallback={
          <div className="flex items-center justify-center h-full p-8 text-text-muted text-sm">
            Failed to render — try selecting a different artifact
          </div>
        }>
          {hasArtifacts
            ? <ArtifactPanel />
            : (connected && activeSessions.length === 0
                ? <div className="p-5"><WaitingForClaude /></div>
                : <IdleHome />)}
        </ErrorBoundary>
      </div>

      {/* Free-form message to agent */}
      {hasArtifacts && <MessageInput />}

      {/* Command palette */}
      {showPalette && <CommandPalette onClose={() => setShowPalette(false)} />}

      {/* Settings sheet */}
      {showSettings && <SettingsSheet onClose={() => setShowSettings(false)} />}

      {/* Keyboard shortcut help overlay */}
      {showHelp && <KeyboardShortcutHelp onClose={() => setShowHelp(false)} />}

      {/* Your taste drawer — cross-project Philosophy Ledger, read-only */}
      {showTaste && (
        <YourTasteDrawer
          initialTab={tasteOpts.initialTab}
          highlightConcept={tasteOpts.highlightConcept}
          onClose={closeTaste}
        />
      )}
      {showConversation && <ConversationRail onClose={() => setShowConversation(false)} />}

      {/* U3 — themed "ask the agent about this artifact" composer (q shortcut) */}
      {askArtifact && (
        <QuickAskModal
          artifactTitle={askArtifact.title}
          onSubmit={(q) =>
            useArtifactStore.getState().submitComment(askArtifact.id, q, undefined, { intent: "question" })
          }
          onClose={() => setAskArtifact(null)}
        />
      )}

      {/* Ephemeral toast stack — pre-flight blocks, etc. */}
      <ToastLayer />
    </div>
  );
}

export default App;
