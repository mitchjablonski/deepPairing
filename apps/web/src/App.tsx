import { PromptInput } from "./components/PromptInput";
import { AgentStatusBar } from "./components/AgentStatusBar";
import { ActivityStream } from "./components/ActivityStream";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { SessionList } from "./components/SessionList";
import { SessionNarrative } from "./components/SessionNarrative";
import { useArtifactStore } from "./stores/artifact";
import { useSessionStore } from "./stores/session";

function App() {
  const hasArtifacts = useArtifactStore((s) => s.artifacts.length > 0);
  const status = useSessionStore((s) => s.status);
  const isActive = status !== "idle";

  return (
    <div className="flex h-screen font-sans bg-white">
      {/* Sidebar */}
      <aside className="w-64 border-r border-gray-200 shrink-0 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-bold">deepPairing</h2>
          <p className="text-xs text-gray-400 mt-1">Collaborative AI framework</p>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {isActive ? <SessionNarrative /> : <SessionList />}
        </div>
      </aside>

      {/* Activity panel */}
      <div className={`flex flex-col min-h-0 ${hasArtifacts ? "w-1/2" : "flex-1"}`}>
        <PromptInput />
        <AgentStatusBar />
        <ActivityStream />
      </div>

      {/* Artifact panel — appears when artifacts exist */}
      {hasArtifacts && (
        <div className="w-1/2 border-l border-gray-200 flex flex-col min-h-0">
          <ArtifactPanel />
        </div>
      )}
    </div>
  );
}

export default App;
