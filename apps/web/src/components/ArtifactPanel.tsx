import { useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { ResearchArtifact } from "./artifacts/ResearchArtifact";
import { PlanArtifact } from "./artifacts/PlanArtifact";
import { CommentThread } from "./CommentThread";
import { ArtifactIcon } from "./icons/ArtifactIcons";

const statusColors: Record<string, string> = {
  draft: "bg-surface-elevated text-text-muted",
  reviewing: "bg-accent-blue-dim text-accent-blue",
  approved: "bg-accent-green-dim text-accent-green",
  revised: "bg-accent-amber-dim text-accent-amber",
  rejected: "bg-accent-red-dim text-accent-red",
  superseded: "bg-surface-elevated text-text-muted",
};

const typeLabels: Record<string, string> = {
  research: "Research",
  plan: "Plans",
  decision: "Decisions",
  code_change: "Code",
  reasoning: "Reasoning",
};

function ArtifactDetail({ artifact }: { artifact: Artifact }) {
  const comments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];
  const generalComments = comments.filter(
    (c) =>
      c.target.lineNumber == null &&
      c.target.findingIndex == null &&
      c.target.stepIndex == null &&
      c.target.lineStart == null,
  );

  return (
    <motion.div
      key={artifact.id}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="flex-1 overflow-y-auto p-4 space-y-4"
    >
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <ArtifactIcon type={artifact.type} className="text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">{artifact.title}</h3>
          <span className={`px-1.5 py-0.5 text-2xs font-medium rounded ${statusColors[artifact.status]}`}>
            {artifact.status}
          </span>
          {artifact.version > 1 && (
            <span className="text-2xs text-text-muted">v{artifact.version}</span>
          )}
        </div>
        {artifact.agentReasoning && (
          <p className="text-xs text-text-muted italic">{artifact.agentReasoning}</p>
        )}
      </div>

      {/* Type-specific renderer */}
      {artifact.type === "research" && <ResearchArtifact artifact={artifact} />}
      {artifact.type === "plan" && <PlanArtifact artifact={artifact} />}
      {artifact.type === "reasoning" && (
        <div className="space-y-2">
          <div className="text-sm text-text-primary">
            <strong>Action:</strong> {(artifact.content as any).action}
          </div>
          <div className="text-sm text-text-secondary">
            <strong>Why:</strong> {(artifact.content as any).reasoning}
          </div>
          {(artifact.content as any).alternativesConsidered?.length > 0 && (
            <div className="text-xs text-text-muted">
              <strong>Alternatives:</strong>{" "}
              {(artifact.content as any).alternativesConsidered.join(", ")}
            </div>
          )}
        </div>
      )}
      {artifact.type === "code_change" && (
        <div className="text-xs font-mono bg-surface-code p-3 rounded overflow-auto whitespace-pre-wrap text-text-secondary">
          {(artifact.content as any).diff ?? JSON.stringify(artifact.content, null, 2)}
        </div>
      )}
      {artifact.type === "decision" && (
        <div className="text-sm text-text-secondary">
          {(artifact.content as any).context}
        </div>
      )}

      {/* General comments */}
      <div className="pt-3 border-t border-border-default">
        <h4 className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-2">
          Comments
        </h4>
        <CommentThread artifactId={artifact.id} comments={generalComments} />
      </div>
    </motion.div>
  );
}

export function ArtifactPanel() {
  const { artifacts, selectedArtifactId, selectArtifact } = useArtifactStore();

  const visibleArtifacts = useMemo(
    () => artifacts.filter((a) => a.status !== "superseded"),
    [artifacts],
  );

  // Group by type for tabs
  const typeGroups = useMemo(() => {
    const groups = new Map<string, Artifact[]>();
    for (const a of visibleArtifacts) {
      const list = groups.get(a.type) ?? [];
      list.push(a);
      groups.set(a.type, list);
    }
    return groups;
  }, [visibleArtifacts]);

  const selectedArtifact = artifacts.find((a) => a.id === selectedArtifactId);

  if (visibleArtifacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3 p-8">
        <ArtifactIcon type="research" className="w-8 h-8 opacity-30" />
        <div className="text-center">
          <p className="text-sm">Artifacts will appear here</p>
          <p className="text-xs mt-1">As the agent researches, decides, and builds</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Type tabs */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-border-default bg-surface-secondary overflow-x-auto">
        {Array.from(typeGroups.entries()).map(([type, items]) => {
          const hasSelected = items.some((a) => a.id === selectedArtifactId);
          return (
            <button
              key={type}
              onClick={() => selectArtifact(items[0].id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-2xs font-medium transition-colors shrink-0 ${
                hasSelected
                  ? "bg-accent-blue-dim text-accent-blue"
                  : "text-text-muted hover:bg-surface-hover hover:text-text-secondary"
              }`}
            >
              <ArtifactIcon type={type} className="w-3 h-3" />
              {typeLabels[type] ?? type}
              <span className="text-2xs opacity-60">{items.length}</span>
            </button>
          );
        })}
      </div>

      {/* Artifact list within selected type */}
      {selectedArtifact && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border-subtle bg-surface-secondary/50 overflow-x-auto">
          {(typeGroups.get(selectedArtifact.type) ?? []).map((a) => (
            <button
              key={a.id}
              onClick={() => selectArtifact(a.id)}
              className={`px-2 py-0.5 rounded text-2xs transition-colors shrink-0 truncate max-w-40 ${
                a.id === selectedArtifactId
                  ? "bg-surface-elevated text-text-primary font-medium"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {a.title}
            </button>
          ))}
        </div>
      )}

      {/* Detail view with crossfade */}
      <AnimatePresence mode="wait">
        {selectedArtifact ? (
          <ArtifactDetail key={selectedArtifact.id} artifact={selectedArtifact} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-text-muted">
            Select an artifact to view details
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
