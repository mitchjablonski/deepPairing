import { useEffect, useState } from "react";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { ExportMenu } from "./components/ExportMenu";
import { SessionBrowser } from "./components/SessionBrowser";
import { TurnIndicator } from "./components/TurnIndicator";
import { PendingBanner } from "./components/PendingBanner";
import { ReviewGate } from "./components/ReviewGate";
import { KeyboardShortcutHelp } from "./components/KeyboardShortcutHelp";
import { MessageInput } from "./components/MessageInput";
import { EditorPicker } from "./components/OpenInEditor";
import { AutonomySlider } from "./components/AutonomySlider";
import { SessionMetrics } from "./components/SessionMetrics";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useArtifactStore } from "./stores/artifact";
import { useConnectionStore } from "./stores/connection";
import { usePreferencesStore } from "./stores/preferences";

function App() {
  const { connected, connect, sessionId, activeSessions, switchSession, refreshSessions } = useConnectionStore();
  const { theme, setTheme, fontSize, setFontSize, contentWidth, toggleContentWidth } = usePreferencesStore();
  const hasArtifacts = useArtifactStore((s) => s.artifacts.length > 0);
  const [showHelp, setShowHelp] = useState(false);
  const [showPalette, setShowPalette] = useState(false);

  // Connect to MCP server WebSocket on mount
  useEffect(() => {
    connect();
    refreshSessions();
    // Poll for new sessions every 10s
    const timer = setInterval(refreshSessions, 10000);
    return () => clearInterval(timer);
  }, [connect, refreshSessions]);

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
      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
      if (e.key === "Escape") {
        setShowHelp(false);
        setShowPalette(false);
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

      if (e.key === "a") {
        const selected = store.artifacts.find((a) => a.id === store.selectedArtifactId);
        if (selected && selected.status === "draft") {
          store.updateArtifactStatus(selected.id, "approved");
        }
      }

      if (e.key === "r") {
        // Focus would go to revision input — for now just log
        const selected = store.artifacts.find((a) => a.id === store.selectedArtifactId);
        if (selected && selected.status === "draft") {
          store.updateArtifactStatus(selected.id, "revised", "Revision requested via keyboard");
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="h-screen bg-surface-primary text-text-primary flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-default bg-surface-secondary">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-bold">deepPairing</h1>
          {/* Session switcher — shown when multiple agents are active */}
          {activeSessions.length > 1 && (
            <div className="flex items-center gap-0.5 bg-surface-elevated rounded p-0.5">
              {activeSessions.map((s, i) => (
                <button
                  key={s.sessionId}
                  onClick={() => switchSession(s.sessionId)}
                  className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                    sessionId === s.sessionId
                      ? "bg-accent-blue-dim text-accent-blue font-medium"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                  title={s.sessionId}
                >
                  Agent {i + 1}
                </button>
              ))}
            </div>
          )}
          <TurnIndicator />
        </div>
        <div className="flex items-center gap-2">
          <EditorPicker />
          <span className="text-2xs text-text-muted">·</span>
          <ExportMenu />
          <span className="text-2xs text-text-muted">·</span>
          <AutonomySlider />
          <span className="text-2xs text-text-muted">·</span>
          <button
            onClick={() => setShowHelp(true)}
            className="px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Keyboard shortcuts (?)"
          >
            <kbd className="font-mono">?</kbd>
          </button>
          <div className="flex items-center gap-0.5 bg-surface-elevated rounded p-0.5" title="Font size">
            {([["compact", 9], ["default", 11], ["large", 13], ["xlarge", 15]] as const).map(([size, px]) => (
              <button
                key={size}
                onClick={() => setFontSize(size)}
                className={`px-1 py-0.5 rounded transition-colors ${
                  fontSize === size
                    ? "bg-surface-hover text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                <span style={{ fontSize: px, lineHeight: 1 }}>A</span>
              </button>
            ))}
          </div>
          <button
            onClick={toggleContentWidth}
            className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-secondary transition-colors"
            title={contentWidth === "full" ? "Constrain content width" : "Full width"}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
              {contentWidth === "full" ? (
                /* Arrows pointing inward → constrain */
                <><path d="M1 6.5h3M9 6.5h3" /><path d="M3 4.5l-2 2 2 2M10 4.5l2 2-2 2" /></>
              ) : (
                /* Arrows pointing outward → expand */
                <><path d="M1 6.5h3M9 6.5h3" /><path d="M2 4.5l2 2-2 2M11 4.5l-2 2 2 2" /></>
              )}
            </svg>
          </button>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-secondary transition-colors"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? (
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
                <circle cx="6.5" cy="6.5" r="2.5" />
                <path d="M6.5 1V2.5M6.5 10.5V12M1 6.5H2.5M10.5 6.5H12M2.6 2.6L3.7 3.7M9.3 9.3L10.4 10.4M2.6 10.4L3.7 9.3M9.3 3.7L10.4 2.6" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 7.5A5 5 0 115.5 2a4 4 0 005.5 5.5z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Disconnected warning */}
      {!connected && (
        <div className="px-3 py-1.5 bg-accent-red-dim/30 border-b border-accent-red/15 text-center">
          <span className="text-2xs text-accent-red">
            Disconnected from server — reconnecting...
          </span>
        </div>
      )}

      {/* Review gate — approve all draft artifacts to proceed */}
      <ReviewGate />
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

      {/* Session metrics */}
      {hasArtifacts && <SessionMetrics />}

      {/* Command palette */}
      {showPalette && <CommandPalette onClose={() => setShowPalette(false)} />}

      {/* Keyboard shortcut help overlay */}
      {showHelp && <KeyboardShortcutHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

export default App;
