import { useEffect, useState } from "react";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { ExportMenu } from "./components/ExportMenu";
import { SessionBrowser } from "./components/SessionBrowser";
import { TurnIndicator } from "./components/TurnIndicator";
import { PendingBanner } from "./components/PendingBanner";
import { ReviewGate } from "./components/ReviewGate";
import { KeyboardShortcutHelp } from "./components/KeyboardShortcutHelp";
import { EditorPicker } from "./components/OpenInEditor";
import { useArtifactStore } from "./stores/artifact";
import { useConnectionStore } from "./stores/connection";
import { usePreferencesStore } from "./stores/preferences";

function App() {
  const { connected, connect } = useConnectionStore();
  const { theme, setTheme } = usePreferencesStore();
  const hasArtifacts = useArtifactStore((s) => s.artifacts.length > 0);
  const [showHelp, setShowHelp] = useState(false);

  // Connect to MCP server WebSocket on mount
  useEffect(() => {
    connect();
  }, [connect]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
      if (e.key === "Escape") {
        setShowHelp(false);
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
          <TurnIndicator />
        </div>
        <div className="flex items-center gap-2">
          <EditorPicker />
          <span className="text-2xs text-text-muted">·</span>
          <ExportMenu />
          <span className="text-2xs text-text-muted">·</span>
          <button
            onClick={() => setShowHelp(true)}
            className="px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Keyboard shortcuts (?)"
          >
            <kbd className="font-mono">?</kbd>
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

      {/* Review gate — approve all draft artifacts to proceed */}
      <ReviewGate />
      {/* Pending decision/plan banner */}
      <PendingBanner />

      {/* Main content */}
      <div className="flex-1 min-h-0">
        {hasArtifacts ? <ArtifactPanel /> : <SessionBrowser />}
      </div>

      {/* Keyboard shortcut help overlay */}
      {showHelp && <KeyboardShortcutHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

export default App;
