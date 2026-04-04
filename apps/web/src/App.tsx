import { Panel, Group as PanelGroup, Separator } from "react-resizable-panels";
import { PromptInput } from "./components/PromptInput";
import { AgentStatusBar } from "./components/AgentStatusBar";
import { ActivityStream } from "./components/ActivityStream";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { Sidebar } from "./components/Sidebar";
import { useArtifactStore } from "./stores/artifact";
import { useEffect } from "react";
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
  // Preferences store used in keyboard shortcut effect below

  // Keyboard shortcuts for panels
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "b") {
        e.preventDefault();
        usePreferencesStore.getState().toggleSidebar();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="h-screen bg-surface-primary text-text-primary flex">
      {/* Sidebar — outside panel group since it has its own collapse logic */}
      <Sidebar />

      {/* Main content panels */}
      <PanelGroup orientation="horizontal" className="flex-1">
        {/* Activity panel */}
        <Panel defaultSize={hasArtifacts ? 55 : 100} minSize={30}>
          <div className="flex flex-col h-full">
            <PromptInput />
            <AgentStatusBar />
            <ActivityStream />
          </div>
        </Panel>

        {/* Artifact panel — visible when artifacts exist */}
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
    </div>
  );
}

export default App;
