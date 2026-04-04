import type { Artifact, Evidence } from "@deeppairing/shared";
import { CommentTrigger } from "../CommentThread";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { useState } from "react";

interface ResearchArtifactProps {
  artifact: Artifact;
}

interface RichFinding {
  category: string;
  title?: string;
  detail: string;
  evidence: string | Evidence[];
  significance: "low" | "medium" | "high";
  impact?: string;
  recommendation?: string;
}

const sigColors = {
  high: "bg-red-100 text-red-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-gray-100 text-gray-600",
};

function EvidenceItem({
  evidence,
  artifactId,
  findingIndex,
  evidenceIndex,
}: {
  evidence: Evidence;
  artifactId: string;
  findingIndex: number;
  evidenceIndex: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const comments = useArtifactStore((s) => s.comments[artifactId]) ?? [];
  const evComments = comments.filter(
    (c) => c.target.findingIndex === findingIndex && c.target.evidenceIndex === evidenceIndex,
  );

  return (
    <div className="mt-2 border border-gray-200 rounded-md overflow-hidden">
      {/* File header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 bg-gray-100 text-xs hover:bg-gray-150 transition-colors"
      >
        <span className="font-mono text-gray-600">
          {evidence.filePath}:{evidence.lineStart}-{evidence.lineEnd}
        </span>
        <div className="flex items-center gap-2">
          {evidence.relatedPaths && evidence.relatedPaths.length > 0 && (
            <span className="text-gray-400">+{evidence.relatedPaths.length} related</span>
          )}
          <CommentTrigger
            artifactId={artifactId}
            target={{ findingIndex, evidenceIndex }}
            existingCount={evComments.length}
          />
          <span className="text-gray-300">{expanded ? "▼" : "▶"}</span>
        </div>
      </button>

      {/* Code snippet */}
      <div className="bg-gray-50 border-t border-gray-200">
        <pre className="px-3 py-2 text-xs font-mono text-gray-800 overflow-x-auto whitespace-pre">
          {evidence.snippet}
        </pre>
      </div>

      {/* Explanation */}
      <div className="px-3 py-2 bg-amber-50 border-t border-gray-200 text-xs text-gray-700">
        {evidence.explanation}
      </div>

      {/* Expanded: context + related paths */}
      {expanded && (
        <>
          {evidence.context && (
            <div className="border-t border-gray-200">
              <div className="px-2.5 py-1 bg-gray-100 text-[10px] font-semibold text-gray-500 uppercase">
                Full Context
              </div>
              <pre className="px-3 py-2 text-xs font-mono text-gray-600 overflow-x-auto whitespace-pre bg-gray-50">
                {evidence.context}
              </pre>
            </div>
          )}
          {evidence.relatedPaths && evidence.relatedPaths.length > 0 && (
            <div className="px-3 py-2 border-t border-gray-200 text-xs">
              <span className="font-medium text-gray-500">Also appears in: </span>
              {evidence.relatedPaths.map((p) => (
                <span key={p} className="inline-block px-1.5 py-0.5 bg-gray-100 rounded font-mono text-gray-600 mr-1">
                  {p}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function renderEvidence(
  evidence: string | Evidence[],
  artifactId: string,
  findingIndex: number,
) {
  if (typeof evidence === "string") {
    return <p className="text-gray-400 mt-0.5 font-mono text-[11px]">{evidence}</p>;
  }

  return (
    <div className="space-y-1">
      {evidence.map((ev, evIdx) => (
        <EvidenceItem
          key={evIdx}
          evidence={ev as Evidence}
          artifactId={artifactId}
          findingIndex={findingIndex}
          evidenceIndex={evIdx}
        />
      ))}
    </div>
  );
}

export function ResearchArtifact({ artifact }: ResearchArtifactProps) {
  const content = artifact.content as {
    summary?: string;
    findings?: RichFinding[];
    openQuestions?: string[];
  };
  const comments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];

  return (
    <div className="space-y-4">
      {content.summary && (
        <p className="text-sm text-gray-700">{content.summary}</p>
      )}

      {content.findings && content.findings.length > 0 && (
        <div className="space-y-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Findings ({content.findings.length})
          </h4>
          {content.findings.map((finding, i) => {
            const findingComments = comments.filter(
              (c) => c.target.findingIndex === i && c.target.evidenceIndex == null,
            );
            return (
              <div key={i} className="p-3 bg-gray-50 rounded-lg border border-gray-100">
                {/* Header */}
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-medium ${sigColors[finding.significance]}`}>
                      {finding.category}
                    </span>
                    {finding.title && (
                      <span className="text-sm font-semibold text-gray-900">{finding.title}</span>
                    )}
                  </div>
                  <CommentTrigger
                    artifactId={artifact.id}
                    target={{ findingIndex: i }}
                    existingCount={findingComments.length}
                  />
                </div>

                {/* Detail */}
                <p className="text-xs text-gray-700 mt-1">{finding.detail}</p>

                {/* Evidence */}
                {renderEvidence(finding.evidence, artifact.id, i)}

                {/* Impact */}
                {finding.impact && (
                  <div className="mt-2 p-2 bg-red-50 border border-red-100 rounded text-xs">
                    <span className="font-semibold text-red-700">Impact: </span>
                    <span className="text-red-800">{finding.impact}</span>
                  </div>
                )}

                {/* Recommendation */}
                {finding.recommendation && (
                  <div className="mt-2 p-2 bg-green-50 border border-green-100 rounded text-xs">
                    <span className="font-semibold text-green-700">Recommendation: </span>
                    <span className="text-green-800">{finding.recommendation}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

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

      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
