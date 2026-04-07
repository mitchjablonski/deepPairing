import type { Artifact, Evidence, Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { FileViewer } from "./FileViewer";
import { CommentableCode } from "../CommentableCode";
import { CommentTrigger } from "../CommentThread";
import { useState, useMemo } from "react";

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
  high: "bg-accent-red-dim text-accent-red",
  medium: "bg-accent-amber-dim text-accent-amber",
  low: "bg-surface-elevated text-text-secondary",
};

function EvidenceItem({
  evidence,
  artifactId,
  findingIndex,
  evidenceIndex,
  allComments,
}: {
  evidence: Evidence;
  artifactId: string;
  findingIndex: number;
  evidenceIndex: number;
  allComments: Comment[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [showFullFile, setShowFullFile] = useState(false);

  // Build a map of comments by line number for this evidence
  const commentsByLine = useMemo(() => {
    const map = new Map<number, Comment[]>();
    for (const c of allComments) {
      if (
        c.target.findingIndex === findingIndex &&
        c.target.evidenceIndex === evidenceIndex &&
        c.target.lineStart != null
      ) {
        const existing = map.get(c.target.lineStart) ?? [];
        existing.push(c);
        map.set(c.target.lineStart, existing);
      }
    }
    return map;
  }, [allComments, findingIndex, evidenceIndex]);

  return (
    <>
      {showFullFile && (
        <FileViewer
          filePath={evidence.filePath}
          highlightStart={evidence.lineStart}
          highlightEnd={evidence.lineEnd}
          artifactId={artifactId}
          onClose={() => setShowFullFile(false)}
        />
      )}
      <div className="mt-2 rounded-md overflow-hidden border border-border-default">
        {/* File header */}
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-surface-elevated text-xs">
          <span className="font-mono text-text-secondary">
            {evidence.filePath}:{evidence.lineStart}-{evidence.lineEnd}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFullFile(true)}
              className="text-text-muted hover:text-accent-blue transition-colors"
              title="Open full file"
            >
              Open file
            </button>
            {evidence.relatedPaths && evidence.relatedPaths.length > 0 && (
              <span className="text-text-muted">+{evidence.relatedPaths.length} related</span>
            )}
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-text-muted hover:text-text-muted"
            >
              {expanded ? "▼" : "▶"}
            </button>
          </div>
        </div>

        {/* Commentable code snippet — hover line to see +, click to comment */}
        <CommentableCode
          code={evidence.snippet}
          language={evidence.language}
          lineStart={evidence.lineStart}
          filePath={evidence.filePath}
          artifactId={artifactId}
          commentsByLine={commentsByLine}
          targetContext={{ findingIndex, evidenceIndex }}
        />

        {/* Explanation */}
        <div className="px-3 py-2 bg-accent-amber-dim/80 border-t border-border-default/20 text-xs text-text-secondary">
          {evidence.explanation}
        </div>

        {/* Expanded: context + related paths */}
        {expanded && (
          <>
            {evidence.context && (
              <div className="border-t border-border-default">
                <div className="px-2.5 py-1 bg-surface-elevated text-[10px] font-semibold text-text-muted uppercase">
                  Full Context
                </div>
                <CommentableCode
                  code={evidence.context}
                  lineStart={1}
                  filePath={evidence.filePath}
                  artifactId={artifactId}
                  targetContext={{ findingIndex, evidenceIndex }}
                />
              </div>
            )}
            {evidence.relatedPaths && evidence.relatedPaths.length > 0 && (
              <div className="px-3 py-2 border-t border-border-default text-xs bg-surface-secondary">
                <span className="font-medium text-text-muted">Also appears in: </span>
                {evidence.relatedPaths.map((p) => (
                  <span key={p} className="inline-block px-1.5 py-0.5 bg-gray-200 rounded font-mono text-text-secondary mr-1">
                    {p}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function renderEvidence(
  evidence: string | Evidence[],
  artifactId: string,
  findingIndex: number,
  allComments: Comment[],
) {
  if (typeof evidence === "string") {
    return <p className="text-text-muted mt-0.5 font-mono text-[11px]">{evidence}</p>;
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
          allComments={allComments}
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
        <p className="text-sm text-text-secondary">{content.summary}</p>
      )}

      {content.findings && content.findings.length > 0 && (
        <div className="space-y-4">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
            Findings ({content.findings.length})
          </h4>
          {content.findings.map((finding, i) => {
            const findingComments = comments.filter(
              (c) => c.target.findingIndex === i && c.target.evidenceIndex == null && c.target.lineStart == null,
            );
            return (
              <div key={i} className="p-3 bg-surface-secondary rounded-lg border border-border-subtle">
                {/* Header */}
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-medium ${sigColors[finding.significance]}`}>
                      {finding.category}
                    </span>
                    {finding.title && (
                      <span className="text-sm font-semibold text-text-primary">{finding.title}</span>
                    )}
                  </div>
                  <CommentTrigger
                    artifactId={artifact.id}
                    target={{ findingIndex: i }}
                    existingCount={findingComments.length}
                  />
                </div>

                {/* Detail */}
                <p className="text-xs text-text-secondary mt-1">{finding.detail}</p>

                {/* Evidence — now with inline commenting on code lines */}
                {renderEvidence(finding.evidence, artifact.id, i, comments)}

                {/* Impact */}
                {finding.impact && (
                  <div className="mt-2 p-2 bg-accent-red-dim border border-accent-red/20 rounded text-xs">
                    <span className="font-semibold text-accent-red">Impact: </span>
                    <span className="text-accent-red">{finding.impact}</span>
                  </div>
                )}

                {/* Recommendation */}
                {finding.recommendation && (
                  <div className="mt-2 p-2 bg-accent-green-dim border border-accent-green/20 rounded text-xs">
                    <span className="font-semibold text-accent-green">Recommendation: </span>
                    <span className="text-accent-green">{finding.recommendation}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {content.openQuestions && content.openQuestions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
            Open Questions
          </h4>
          <ul className="text-xs text-text-secondary space-y-1">
            {content.openQuestions.map((q, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-accent-amber mt-0.5">?</span>
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
