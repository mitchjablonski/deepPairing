import type { Artifact } from "@deeppairing/shared";
import { CommentTrigger } from "../CommentThread";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactStatusActions } from "./ArtifactStatusActions";

interface PlanArtifactProps {
  artifact: Artifact;
}

interface PlanStep {
  description: string;
  files: string[];
  reasoning: string;
}

export function PlanArtifact({ artifact }: PlanArtifactProps) {
  const content = artifact.content as {
    steps?: PlanStep[];
    estimatedChanges?: number;
  };
  const comments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];

  return (
    <div className="space-y-4">
      {/* Steps */}
      {content.steps && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Implementation Steps ({content.steps.length})
            </h4>
            {content.estimatedChanges && (
              <span className="text-xs text-gray-400">
                ~{content.estimatedChanges} file changes
              </span>
            )}
          </div>

          {content.steps.map((step, i) => {
            const stepComments = comments.filter(
              (c) => c.target.stepIndex === i,
            );
            return (
              <div
                key={i}
                className="p-3 bg-gray-50 rounded-md border border-gray-100"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center mt-0.5">
                      {i + 1}
                    </span>
                    <div>
                      <p className="text-sm text-gray-800 font-medium">
                        {step.description}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {step.reasoning}
                      </p>
                      {step.files.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {step.files.map((f, fIdx) => {
                            const filePath = typeof f === "string" ? f : (f as any).filePath;
                            const desc = typeof f === "string" ? null : (f as any).description;
                            const changeType = typeof f === "string" ? null : (f as any).changeType;
                            const changeIcon = changeType === "create" ? "+" : changeType === "delete" ? "-" : "~";
                            return (
                              <span
                                key={fIdx}
                                className="px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded text-[11px] font-mono"
                                title={desc ?? undefined}
                              >
                                {changeType && <span className="text-gray-400 mr-0.5">{changeIcon}</span>}
                                {filePath}
                              </span>
                            );
                          })}
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

      {/* Actions */}
      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
