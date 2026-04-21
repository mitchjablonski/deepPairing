import { useEffect, useState } from "react";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { SessionBrowser } from "./components/SessionBrowser";
import { TurnIndicator } from "./components/TurnIndicator";
import { PendingBanner } from "./components/PendingBanner";
import { KeyboardShortcutHelp } from "./components/KeyboardShortcutHelp";
import { MessageInput } from "./components/MessageInput";
import { AutonomySlider } from "./components/AutonomySlider";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsSheet } from "./components/SettingsSheet";
import { ReplayScrubber } from "./components/ReplayScrubber";
import { ToastLayer } from "./components/ToastLayer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { YourTasteDrawer } from "./components/YourTasteDrawer";
import { SkillLoadBanner } from "./components/SkillLoadBanner";
import { useArtifactStore } from "./stores/artifact";
import { useConnectionStore } from "./stores/connection";

function App() {
  const { connected, connect, sessionId, activeSessions, switchSession, refreshSessions } = useConnectionStore();
  const hasArtifacts = useArtifactStore((s) => s.artifacts.length > 0);
  const [showHelp, setShowHelp] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTaste, setShowTaste] = useState(false);

  // Fetch active sessions on mount, auto-connect to the first one
  useEffect(() => {
    const init = async () => {
      refreshSessions();
      // Fetch sessions and auto-connect to the first (or only) one
      try {
        const res = await fetch(`http://${window.location.host}/api/active-sessions`);
        const data = await res.json();
        const sessions = data.sessions ?? [];
        if (sessions.length > 0) {
          connect(sessions[0].sessionId);
        } else {
          connect(); // Fallback: global connection
        }
      } catch {
        connect();
      }
    };
    init();
    // Poll for new sessions every 10s
    const timer = setInterval(refreshSessions, 10000);
    return () => clearInterval(timer);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

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
        setShowTaste(false);
      }

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
        // Ask the user for a question and submit it with intent: "question".
        // A richer input affordance lives on findings via AskTrigger — this
        // is the artifact-root equivalent for keyboard users.
        const question = window.prompt(`Ask the agent about "${selected.title}":`);
        if (question && question.trim()) {
          store.submitComment(selected.id, question.trim(), undefined, { intent: "question" });
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // O2: the PreflightBlockToast action dispatches this event to open the
  // Your Taste drawer. Decoupled so the toast doesn't need a ref to App state.
  useEffect(() => {
    const openTaste = () => setShowTaste(true);
    window.addEventListener("dp:open-your-taste", openTaste);
    return () => window.removeEventListener("dp:open-your-taste", openTaste);
  }, []);

  // O7: question-answered toast's "Jump to answer" action selects the
  // artifact the answer belongs to, scrolling it into view.
  useEffect(() => {
    const focus = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as { artifactId?: string } | undefined;
      if (!detail?.artifactId) return;
      useArtifactStore.getState().selectArtifact(detail.artifactId);
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
          <TurnIndicator />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <AutonomySlider />
          <span className="text-2xs text-text-muted mx-1">·</span>
          <button
            onClick={() => setShowTaste(true)}
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

      {/* Main content */}
      <div className="flex-1 min-h-0">
        <ErrorBoundary fallback={
          <div className="flex items-center justify-center h-full p-8 text-text-muted text-sm">
            Failed to render — try selecting a different artifact
          </div>
        }>
          {hasArtifacts ? <ArtifactPanel /> : <SessionBrowser />}
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
      {showTaste && <YourTasteDrawer onClose={() => setShowTaste(false)} />}

      {/* Ephemeral toast stack — pre-flight blocks, etc. */}
      <ToastLayer />
    </div>
  );
}

export default App;
