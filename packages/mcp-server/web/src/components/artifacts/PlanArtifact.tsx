import type { Artifact } from "@deeppairing/shared";
import { CommentTrigger } from "../CommentThread";
import { CommentableCode } from "../CommentableCode";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactStatusActions } from "./ArtifactStatusActions";

/** Clickable badges that link to the finding artifacts that motivated a step */
function MotivatedByBadges({ labels }: { labels: string[] }) {
  const { artifacts, selectArtifact } = useArtifactStore();

  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      <span className="text-[10px] text-text-muted">From:</span>
      {labels.map((label, i) => {
        // Try to find matching research artifact by title
        const match = artifacts.find(
          (a) => a.type === "research" && a.title.toLowerCase().includes(label.toLowerCase()),
        ) ?? artifacts.find(
          (a) => a.type === "research" && (a.content as any)?.findings?.some(
            (f: any) => f.title?.toLowerCase().includes(label.toLowerCase()),
          ),
        );

        if (match) {
          return (
            <button
              key={i}
              onClick={() => selectArtifact(match.id)}
              className="px-1.5 py-0.5 bg-accent-amber-dim text-accent-amber rounded text-[10px]
                         hover:bg-accent-amber-dim/80 transition-colors cursor-pointer"
              title={`View finding: ${label}`}
            >
              {label} →
            </button>
          );
        }

        return (
          <span key={i} className="px-1.5 py-0.5 bg-accent-amber-dim text-accent-amber rounded text-[10px]">
            {label}
          </span>
        );
      })}
    </div>
  );
}

interface PlanArtifactProps {
  artifact: Artifact;
}

interface PlanStep {
  description: string;
  files: (string | { filePath: string; description?: string; changeType?: string })[];
  reasoning: string;
  motivatedBy?: string[];
  preview?: { before: string; after: string; filePath: string };
}

export function PlanArtifact({ artifact }: PlanArtifactProps) {
  const content = artifact.content as {
    steps?: PlanStep[];
    estimatedChanges?: number;
  };
  const comments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];

  return (
    <div className="space-y-4">
      {content.steps && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Implementation Steps ({content.steps.length})
            </h4>
            {content.estimatedChanges != null && (
              <span className="text-xs text-text-muted">
                ~{content.estimatedChanges} file changes
              </span>
            )}
          </div>

          {content.steps.map((step, i) => {
            const stepComments = comments.filter(
              (c) => c.target.stepIndex === i && c.target.lineStart == null,
            );
            return (
              <div
                key={i}
                className="p-3 bg-surface-secondary rounded-lg border border-border-subtle"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-accent-blue-dim text-accent-blue text-xs font-bold flex items-center justify-center mt-0.5">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary font-medium">
                        {step.description}
                      </p>
                      <p className="text-xs text-text-muted mt-0.5">
                        {step.reasoning}
                      </p>

                      {/* Motivated by badges */}
                      {step.motivatedBy && step.motivatedBy.length > 0 && (
                        <MotivatedByBadges labels={step.motivatedBy} />
                      )}

                      {/* File list */}
                      {step.files.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {step.files.map((f, fIdx) => {
                            const filePath = typeof f === "string" ? f : f.filePath;
                            const desc = typeof f === "string" ? null : f.description;
                            const changeType = typeof f === "string" ? null : f.changeType;
                            const changeIcon = changeType === "create" ? "+" : changeType === "delete" ? "-" : "~";
                            return (
                              <span
                                key={fIdx}
                                className="px-1.5 py-0.5 bg-gray-200 text-text-secondary rounded text-[11px] font-mono"
                                title={desc ?? undefined}
                              >
                                {changeType && <span className="text-text-muted mr-0.5">{changeIcon}</span>}
                                {filePath}
                              </span>
                            );
                          })}
                        </div>
                      )}

                      {/* Before/after preview with inline commenting */}
                      {step.preview && (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <div>
                            <div className="text-[10px] font-semibold text-accent-red uppercase mb-0.5">Before</div>
                            <CommentableCode
                              code={step.preview.before}
                              lineStart={1}
                              filePath={step.preview.filePath}
                              artifactId={artifact.id}
                              targetContext={{ stepIndex: i }}
                            />
                          </div>
                          <div>
                            <div className="text-[10px] font-semibold text-accent-green uppercase mb-0.5">After</div>
                            <CommentableCode
                              code={step.preview.after}
                              lineStart={1}
                              filePath={step.preview.filePath}
                              artifactId={artifact.id}
                              targetContext={{ stepIndex: i }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <CommentTrigger
                    artifactId={artifact.id}
                    target={{ stepIndex: i }}
                    existingCount={stepComments.length}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
