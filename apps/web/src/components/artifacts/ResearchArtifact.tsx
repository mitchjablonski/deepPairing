import type { Artifact } from "@deeppairing/shared";
import { CommentTrigger } from "../CommentThread";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactStatusActions } from "./ArtifactStatusActions";

interface ResearchArtifactProps {
  artifact: Artifact;
}

interface Finding {
  category: string;
  detail: string;
  evidence: string;
  significance: "low" | "medium" | "high";
}

const sigColors = {
  high: "bg-red-100 text-red-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-gray-100 text-gray-600",
};

export function ResearchArtifact({ artifact }: ResearchArtifactProps) {
  const content = artifact.content as {
    summary?: string;
    findings?: Finding[];
    openQuestions?: string[];
  };
  const comments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];

  return (
    <div className="space-y-4">
      {/* Summary */}
      {content.summary && (
        <p className="text-sm text-gray-700">{content.summary}</p>
      )}

      {/* Findings */}
      {content.findings && content.findings.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Findings ({content.findings.length})
          </h4>
          {content.findings.map((finding, i) => {
            const findingComments = comments.filter(
              (c) => c.target.findingIndex === i,
            );
            return (
              <div
                key={i}
                className="flex items-start gap-2 p-2 bg-gray-50 rounded-md text-xs group"
              >
                <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${sigColors[finding.significance]}`}>
                  {finding.category}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-gray-800">{finding.detail}</p>
                  <p className="text-gray-400 mt-0.5 font-mono text-[11px]">{finding.evidence}</p>
                </div>
                <CommentTrigger
                  artifactId={artifact.id}
                  target={{ findingIndex: i }}
                  existingCount={findingComments.length}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Open questions */}
      {content.openQuestions && content.openQuestions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            Open Questions
          </h4>
          <ul className="text-xs text-gray-600 space-y-1">
            {content.openQuestions.map((q, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-amber-500 mt-0.5">?</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
