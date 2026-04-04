import { useArtifactStore } from "../stores/artifact";
import { useSessionStore } from "../stores/session";

const phaseOrder = ["research", "decision", "plan", "code_change", "reasoning"] as const;

const phaseLabels: Record<string, { label: string; icon: string }> = {
  research: { label: "Explored", icon: "🔍" },
  decision: { label: "Decided", icon: "⚖️" },
  plan: { label: "Planned", icon: "📋" },
  code_change: { label: "Built", icon: "✏️" },
  reasoning: { label: "Reasoned", icon: "💭" },
};

const statusDot: Record<string, string> = {
  draft: "bg-gray-400",
  reviewing: "bg-blue-400",
  approved: "bg-green-500",
  revised: "bg-amber-500",
  rejected: "bg-red-500",
  superseded: "bg-gray-300",
};

export function SessionNarrative() {
  const { artifacts, selectArtifact } = useArtifactStore();
  const status = useSessionStore((s) => s.status);

  if (artifacts.length === 0 && status === "idle") {
    return <p className="text-xs text-gray-400 px-2">Start a session to see the narrative</p>;
  }

  if (artifacts.length === 0) {
    return <p className="text-xs text-gray-400 px-2">Agent is working...</p>;
  }

  // Group artifacts by type, in phase order
  const grouped = new Map<string, typeof artifacts>();
  for (const phase of phaseOrder) {
    const matching = artifacts.filter(
      (a) => a.type === phase && a.status !== "superseded",
    );
    if (matching.length > 0) {
      grouped.set(phase, matching);
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-2">
        Session Story
      </div>

      {Array.from(grouped.entries()).map(([phase, phaseArtifacts]) => {
        const meta = phaseLabels[phase] ?? { label: phase, icon: "📄" };

        return (
          <div key={phase}>
            <div className="flex items-center gap-1.5 px-2 mb-1">
              <span className="text-xs">{meta.icon}</span>
              <span className="text-[10px] font-semibold text-gray-500 uppercase">
                {meta.label}
              </span>
            </div>

            <div className="space-y-0.5">
              {phaseArtifacts.map((artifact) => (
                <button
                  key={artifact.id}
                  onClick={() => selectArtifact(artifact.id)}
                  className="w-full text-left px-2 py-1 rounded hover:bg-gray-100 transition-colors flex items-center gap-2"
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot[artifact.status]}`}
                  />
                  <span className="text-xs text-gray-700 truncate">
                    {artifact.title}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
