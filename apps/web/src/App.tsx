import { PromptInput } from "./components/PromptInput";
import { AgentStatusBar } from "./components/AgentStatusBar";
import { ActivityStream } from "./components/ActivityStream";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { SessionList } from "./components/SessionList";
import { SessionNarrative } from "./components/SessionNarrative";
import { useArtifactStore } from "./stores/artifact";
import { useSessionStore } from "./stores/session";
import { usePreferencesStore } from "./stores/preferences";

function App() {
  const hasArtifacts = useArtifactStore((s) => s.artifacts.length > 0);
  const status = useSessionStore((s) => s.status);
  const isActive = status !== "idle";
  const { sidebarCollapsed, toggleSidebar, theme, setTheme } = usePreferencesStore();

  return (
    <div className="flex h-screen bg-surface-primary text-text-primary">
      {/* Sidebar */}
      <aside
        className={`border-r border-border-default shrink-0 flex flex-col transition-[width] duration-200 ${
          sidebarCollapsed ? "w-12" : "w-60"
        }`}
      >
        <div className="p-3 border-b border-border-default flex items-center justify-between">
          {!sidebarCollapsed && (
            <div>
              <h2 className="text-sm font-bold">deepPairing</h2>
              <p className="text-2xs text-text-muted mt-0.5">Collaborative AI</p>
            </div>
          )}
          <button
            onClick={toggleSidebar}
            className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-secondary transition-colors"
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? "▶" : "◀"}
          </button>
        </div>

        {!sidebarCollapsed && (
          <div className="flex-1 overflow-y-auto p-2">
            {isActive ? <SessionNarrative /> : <SessionList />}
          </div>
        )}

        {/* Theme toggle at bottom */}
        <div className="border-t border-border-default p-2">
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="w-full flex items-center justify-center gap-2 p-1.5 rounded text-2xs text-text-muted hover:bg-surface-hover hover:text-text-secondary transition-colors"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "☀" : "🌙"}
            {!sidebarCollapsed && (theme === "dark" ? "Light mode" : "Dark mode")}
          </button>
        </div>
      </aside>

      {/* Activity panel */}
      <div className={`flex flex-col min-h-0 ${hasArtifacts ? "w-1/2" : "flex-1"}`}>
        <PromptInput />
        <AgentStatusBar />
        <ActivityStream />
      </div>

      {/* Artifact panel */}
      {hasArtifacts && (
        <div className="w-1/2 border-l border-border-default flex flex-col min-h-0">
          <ArtifactPanel />
        </div>
      )}
    </div>
  );
}

export default App;
