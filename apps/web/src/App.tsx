import { Panel, Group as PanelGroup, Separator } from "react-resizable-panels";
import { PromptInput } from "./components/PromptInput";
import { AgentStatusBar } from "./components/AgentStatusBar";
import { ActivityStream } from "./components/activity/ActivityStream";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { Sidebar } from "./components/Sidebar";
import { KeyboardShortcutHelp } from "./components/KeyboardShortcutHelp";
import { useArtifactStore } from "./stores/artifact";
import { useEffect, useState } from "react";
import { usePreferencesStore } from "./stores/preferences";

function ResizeHandle() {
  return (
    <Separator
      className="group relative flex items-center justify-center w-1.5 hover:w-2 transition-[width]"
    >
      <div className="w-px h-full bg-border-default group-hover:bg-accent-blue group-active:bg-accent-blue transition-colors" />
    </Separator>
  );
}

function App() {
  const hasArtifacts = useArtifactStore((s) => s.artifacts.length > 0);
  const [showHelp, setShowHelp] = useState(false);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "b") {
        e.preventDefault();
        usePreferencesStore.getState().toggleSidebar();
      }

      if (mod && e.key === "/") {
        e.preventDefault();
        setShowHelp((v) => !v);
      }

      if (e.key === "Escape") {
        setShowHelp(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="h-screen bg-surface-primary text-text-primary flex">
      <Sidebar />

      <PanelGroup orientation="horizontal" className="flex-1">
        <Panel defaultSize={hasArtifacts ? 55 : 100} minSize={30}>
          <div className="flex flex-col h-full">
            <PromptInput />
            <AgentStatusBar />
            <ActivityStream />
          </div>
        </Panel>

        {hasArtifacts && (
          <>
            <ResizeHandle />
            <Panel defaultSize={45} minSize={25}>
              <div className="h-full border-l border-border-default">
                <ArtifactPanel />
              </div>
            </Panel>
          </>
        )}
      </PanelGroup>

      {/* Keyboard shortcut help overlay */}
      {showHelp && <KeyboardShortcutHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

export default App;
