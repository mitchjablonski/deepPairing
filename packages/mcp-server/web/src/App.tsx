import { useEffect } from "react";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { useConnectionStore } from "./stores/connection";
import { usePreferencesStore } from "./stores/preferences";

function App() {
  const { connected, connect } = useConnectionStore();
  const { theme, setTheme } = usePreferencesStore();

  // Connect to MCP server WebSocket on mount
  useEffect(() => {
    connect();
  }, [connect]);

  return (
    <div className="h-screen bg-surface-primary text-text-primary flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-default bg-surface-secondary">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-bold">deepPairing</h1>
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-medium ${
            connected
              ? "bg-accent-green-dim text-accent-green"
              : "bg-accent-red-dim text-accent-red"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-accent-green" : "bg-accent-red"} ${connected ? "" : "animate-pulse"}`} />
            {connected ? "Connected" : "Connecting..."}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-2xs text-text-muted">Companion UI</span>
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

      {/* Main content — artifact panel fills the screen */}
      <div className="flex-1 min-h-0">
        <ArtifactPanel />
      </div>
    </div>
  );
}

export default App;
