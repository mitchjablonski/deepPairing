import { SessionList } from "./SessionList";
import { SessionNarrative } from "./SessionNarrative";
import { useSessionStore } from "../stores/session";
import { usePreferencesStore } from "../stores/preferences";

export function Sidebar() {
  const status = useSessionStore((s) => s.status);
  const isActive = status !== "idle";
  const { sidebarCollapsed, toggleSidebar, theme, setTheme } = usePreferencesStore();

  return (
    <aside
      className={`border-r border-border-default shrink-0 flex flex-col bg-surface-secondary transition-[width] duration-200 ${
        sidebarCollapsed ? "w-11" : "w-56"
      }`}
    >
      {/* Header */}
      <div className="p-2.5 border-b border-border-default flex items-center justify-between min-h-[44px]">
        {!sidebarCollapsed && (
          <div className="min-w-0">
            <h2 className="text-sm font-bold truncate">deepPairing</h2>
            <p className="text-2xs text-text-muted">Collaborative AI</p>
          </div>
        )}
        <button
          onClick={toggleSidebar}
          className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-secondary transition-colors shrink-0"
          title={sidebarCollapsed ? "Expand (⌘B)" : "Collapse (⌘B)"}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-current">
            {sidebarCollapsed ? (
              <path d="M5 3L9 7L5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M9 3L5 7L9 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </button>
      </div>

      {/* Content */}
      {!sidebarCollapsed && (
        <div className="flex-1 overflow-y-auto p-1.5">
          {isActive ? <SessionNarrative /> : <SessionList />}
        </div>
      )}

      {/* Collapsed: icon placeholders */}
      {sidebarCollapsed && (
        <div className="flex-1 flex flex-col items-center pt-2 gap-1">
          <button
            className="p-1.5 rounded hover:bg-surface-hover text-text-muted transition-colors"
            title="Sessions"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="2" width="12" height="2" rx="0.5" fill="currentColor" opacity="0.7" />
              <rect x="1" y="6" width="12" height="2" rx="0.5" fill="currentColor" opacity="0.5" />
              <rect x="1" y="10" width="12" height="2" rx="0.5" fill="currentColor" opacity="0.3" />
            </svg>
          </button>
        </div>
      )}

      {/* Footer: theme toggle */}
      <div className="border-t border-border-default p-1.5">
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="w-full flex items-center justify-center gap-1.5 p-1.5 rounded text-2xs text-text-muted hover:bg-surface-hover hover:text-text-secondary transition-colors"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? (
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <circle cx="6.5" cy="6.5" r="2.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M6.5 1V2.5M6.5 10.5V12M1 6.5H2.5M10.5 6.5H12M2.6 2.6L3.7 3.7M9.3 9.3L10.4 10.4M2.6 10.4L3.7 9.3M9.3 3.7L10.4 2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M11 7.5A5 5 0 115.5 2a4 4 0 005.5 5.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {!sidebarCollapsed && (theme === "dark" ? "Light" : "Dark")}
        </button>
      </div>
    </aside>
  );
}
