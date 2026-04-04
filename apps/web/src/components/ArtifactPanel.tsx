import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { ResearchArtifact } from "./artifacts/ResearchArtifact";
import { PlanArtifact } from "./artifacts/PlanArtifact";
import { CommentThread } from "./CommentThread";

const typeIcons: Record<string, string> = {
  research: "🔍",
  plan: "📋",
  decision: "⚖️",
  code_change: "✏️",
  reasoning: "💭",
};

const statusColors: Record<string, string> = {
  draft: "bg-gray-200 text-gray-700",
  reviewing: "bg-blue-100 text-blue-700",
  approved: "bg-green-100 text-green-700",
  revised: "bg-amber-100 text-amber-700",
  rejected: "bg-red-100 text-red-700",
  superseded: "bg-gray-100 text-gray-400",
};

function ArtifactListItem({
  artifact,
  isSelected,
  onClick,
}: {
  artifact: Artifact;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
        isSelected
          ? "bg-blue-50 border border-blue-200"
          : "hover:bg-gray-50 border border-transparent"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm">{typeIcons[artifact.type] ?? "📄"}</span>
        <span className="text-xs font-medium text-gray-800 truncate flex-1">
          {artifact.title}
        </span>
        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${statusColors[artifact.status]}`}>
          {artifact.status}
        </span>
      </div>
      {artifact.version > 1 && (
        <span className="text-[10px] text-gray-400 ml-6">v{artifact.version}</span>
      )}
    </button>
  );
}

function ArtifactDetail({ artifact }: { artifact: Artifact }) {
  const comments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];
  const generalComments = comments.filter(
    (c) =>
      c.target.lineNumber == null &&
      c.target.findingIndex == null &&
      c.target.stepIndex == null,
  );

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">{typeIcons[artifact.type] ?? "📄"}</span>
          <h3 className="text-sm font-semibold text-gray-900">{artifact.title}</h3>
          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${statusColors[artifact.status]}`}>
            {artifact.status}
          </span>
          {artifact.version > 1 && (
            <span className="text-xs text-gray-400">v{artifact.version}</span>
          )}
        </div>
        {artifact.agentReasoning && (
          <p className="text-xs text-gray-500 italic">{artifact.agentReasoning}</p>
        )}
      </div>

      {/* Type-specific renderer */}
      {artifact.type === "research" && <ResearchArtifact artifact={artifact} />}
      {artifact.type === "plan" && <PlanArtifact artifact={artifact} />}
      {artifact.type === "reasoning" && (
        <div className="space-y-2">
          <div className="text-sm text-gray-700">
            <strong>Action:</strong> {(artifact.content as any).action}
          </div>
          <div className="text-sm text-gray-700">
            <strong>Why:</strong> {(artifact.content as any).reasoning}
          </div>
          {(artifact.content as any).alternativesConsidered?.length > 0 && (
            <div className="text-xs text-gray-500">
              <strong>Alternatives considered:</strong>{" "}
              {(artifact.content as any).alternativesConsidered.join(", ")}
            </div>
          )}
        </div>
      )}
      {artifact.type === "code_change" && (
        <div className="text-xs font-mono bg-gray-50 p-3 rounded overflow-auto whitespace-pre-wrap">
          {(artifact.content as any).diff ?? JSON.stringify(artifact.content, null, 2)}
        </div>
      )}
      {artifact.type === "decision" && (
        <div className="text-sm text-gray-700">
          {(artifact.content as any).context}
        </div>
      )}

      {/* General comments (not targeted at specific locations) */}
      {generalComments.length > 0 && (
        <div className="pt-3 border-t border-gray-100">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Comments
          </h4>
          <CommentThread
            artifactId={artifact.id}
            comments={generalComments}
          />
        </div>
      )}

      {/* Always show comment input for general comments */}
      {generalComments.length === 0 && (
        <div className="pt-3 border-t border-gray-100">
          <CommentThread artifactId={artifact.id} comments={[]} />
        </div>
      )}
    </div>
  );
}

export function ArtifactPanel() {
  const { artifacts, selectedArtifactId, selectArtifact } = useArtifactStore();

  if (artifacts.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400">
        Artifacts will appear here as the agent works
      </div>
    );
  }

  const selectedArtifact = artifacts.find((a) => a.id === selectedArtifactId);
  // Show non-superseded artifacts
  const visibleArtifacts = artifacts.filter((a) => a.status !== "superseded");

  return (
    <div className="flex flex-col h-full">
      {/* Artifact list */}
      <div className="border-b border-gray-200 p-2 space-y-0.5 max-h-48 overflow-y-auto bg-gray-50">
        <div className="px-2 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Artifacts ({visibleArtifacts.length})
        </div>
        {visibleArtifacts.map((artifact) => (
          <ArtifactListItem
            key={artifact.id}
            artifact={artifact}
            isSelected={artifact.id === selectedArtifactId}
            onClick={() => selectArtifact(artifact.id)}
          />
        ))}
      </div>

      {/* Detail view */}
      {selectedArtifact ? (
        <ArtifactDetail artifact={selectedArtifact} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
          Select an artifact to view details
        </div>
      )}
    </div>
  );
}
