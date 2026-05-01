import type { Artifact } from "@deeppairing/shared";
import { CommentableCode } from "../CommentableCode";
import { OpenInEditorLink } from "../OpenInEditor";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { ConceptBadge } from "../ConceptBadge";
import { useState, useMemo } from "react";
import { computeLineDiff, type DiffLine } from "../../lib/diff";

interface CodeChangeContent {
  filePath: string;
  changeType: "create" | "modify" | "delete";
  before: string;
  after: string;
  reasoning: string;
  // Y5 — named pattern this change embodies. Drives ConceptBadge rendering
  // and (eventually) preflight matching against past project rejections.
  concept?: { name: string; oneLineExplanation?: string };
}

function UnifiedDiffView({ diff, filePath, artifactId }: { diff: DiffLine[]; filePath: string; artifactId: string }) {
  return (
    <div className="font-mono text-[13px] leading-[20px] bg-surface-code rounded overflow-hidden">
      {diff.map((line, i) => (
        <div
          key={i}
          className={`flex ${
            line.type === "removed"
              ? "bg-accent-red-dim/30"
              : line.type === "added"
                ? "bg-accent-green-dim/30"
                : ""
          }`}
        >
          {/* Old line number */}
          <span className="w-8 shrink-0 text-right pr-1 py-0.5 text-[11px] text-text-muted select-none">
            {line.oldLineNum ?? ""}
          </span>
          {/* New line number */}
          <span className="w-8 shrink-0 text-right pr-2 py-0.5 text-[11px] text-text-muted select-none border-r border-border-subtle">
            {line.newLineNum ?? ""}
          </span>
          {/* Diff marker */}
          <span className={`w-5 shrink-0 text-center py-0.5 select-none font-bold ${
            line.type === "removed"
              ? "text-accent-red"
              : line.type === "added"
                ? "text-accent-green"
                : "text-text-muted"
          }`}>
            {line.type === "removed" ? "-" : line.type === "added" ? "+" : " "}
          </span>
          {/* Code content */}
          <span className={`px-2 py-0.5 whitespace-pre flex-1 overflow-x-auto ${
            line.type === "removed"
              ? "text-accent-red line-through opacity-70"
              : line.type === "added"
                ? "text-text-primary"
                : "text-text-secondary"
          }`}>
            {line.content || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CodeChangeArtifact({ artifact }: { artifact: Artifact }) {
  const content = artifact.content as CodeChangeContent;
  const hasBefore = Boolean(content.before);
  const [viewMode, setViewMode] = useState<"unified" | "split" | "result">(
    hasBefore ? "unified" : "result",
  );

  const diff = useMemo(() => {
    if (!content.before || !content.after) return null;
    return computeLineDiff(content.before, content.after);
  }, [content.before, content.after]);

  const changeTypeColors = {
    create: "bg-accent-green-dim text-accent-green",
    modify: "bg-accent-amber-dim text-accent-amber",
    delete: "bg-accent-red-dim text-accent-red",
  };

  const diffStats = useMemo(() => {
    if (!diff) return null;
    const added = diff.filter((l) => l.type === "added").length;
    const removed = diff.filter((l) => l.type === "removed").length;
    return { added, removed };
  }, [diff]);

  return (
    <div className="space-y-3">
      {/* File header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`px-1.5 py-0.5 text-2xs font-medium rounded ${changeTypeColors[content.changeType]}`}>
            {content.changeType}
          </span>
          <span className="text-sm font-mono text-text-primary">{content.filePath}</span>
          <OpenInEditorLink filePath={content.filePath} line={1} />
          {diffStats && (
            <span className="text-2xs text-text-muted">
              <span className="text-accent-green">+{diffStats.added}</span>
              {" "}
              <span className="text-accent-red">-{diffStats.removed}</span>
            </span>
          )}
        </div>
        {hasBefore && (
          <div className="flex items-center gap-0.5 bg-surface-elevated rounded p-0.5">
            <button
              onClick={() => setViewMode("unified")}
              className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                viewMode === "unified" ? "bg-surface-hover text-text-primary" : "text-text-muted"
              }`}
            >
              Unified
            </button>
            <button
              onClick={() => setViewMode("split")}
              className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                viewMode === "split" ? "bg-surface-hover text-text-primary" : "text-text-muted"
              }`}
            >
              Split
            </button>
            <button
              onClick={() => setViewMode("result")}
              className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                viewMode === "result" ? "bg-surface-hover text-text-primary" : "text-text-muted"
              }`}
            >
              Result
            </button>
          </div>
        )}
      </div>

      {/* Y5 — concept badge above the "Why" so the pattern frames the
          reasoning. When the agent named the concept, this is the
          single most ledger-relevant element on the artifact. */}
      {content.concept?.name && (
        <ConceptBadge
          name={content.concept.name}
          explanation={content.concept.oneLineExplanation}
          size="md"
        />
      )}

      {/* Reasoning */}
      {content.reasoning && (
        <div className="px-3 py-2 bg-accent-violet-dim/30 border-l-2 border-accent-violet rounded-r text-xs">
          <span className="font-semibold text-accent-violet">Why: </span>
          <span className="text-text-secondary">{content.reasoning}</span>
        </div>
      )}

      {/* Code view */}
      {viewMode === "unified" && diff ? (
        <UnifiedDiffView diff={diff} filePath={content.filePath} artifactId={artifact.id} />
      ) : viewMode === "split" && content.before ? (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-2xs font-semibold text-accent-red mb-1">Before</div>
            <div className="opacity-40">
              <CommentableCode
                code={content.before}
                lineStart={1}
                filePath={content.filePath}
                artifactId={artifact.id}
              />
            </div>
          </div>
          <div>
            <div className="text-2xs font-semibold text-accent-green mb-1">After</div>
            <div className="border-l-2 border-accent-green rounded-l">
              <CommentableCode
                code={content.after}
                lineStart={1}
                filePath={content.filePath}
                artifactId={artifact.id}
              />
            </div>
          </div>
        </div>
      ) : (
        <CommentableCode
          code={content.after || content.before}
          lineStart={1}
          filePath={content.filePath}
          artifactId={artifact.id}
        />
      )}

      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
