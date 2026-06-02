import type { Artifact, Comment } from "@deeppairing/shared";
import { CommentableCode } from "../CommentableCode";
import { OpenInEditorLink } from "../OpenInEditor";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { ConceptBadge } from "../ConceptBadge";
import { useState, useMemo } from "react";
import { useArtifactStore } from "../../stores/artifact";
import { computeLineDiff, collapseDiff, type DiffLine, type DiffRow } from "../../lib/diff";

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

function UnifiedDiffView({ diff }: { diff: DiffLine[] }) {
  // Collapse long unchanged runs into gap markers so an incremental edit to an
  // already-approved file shows just the changed hunks (+ context), not the
  // whole file. "Show all lines" / clicking a gap reveals everything.
  const [expanded, setExpanded] = useState(false);
  const collapsed = useMemo(() => collapseDiff(diff), [diff]);
  const hidesLines = useMemo(() => collapsed.some((r) => r.type === "gap"), [collapsed]);
  const rows: DiffRow[] = expanded ? diff : collapsed;

  return (
    <div className="font-mono text-[13px] leading-[20px] bg-surface-code rounded overflow-hidden">
      {hidesLines && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full text-left px-2 py-1 text-2xs text-text-muted hover:text-text-secondary bg-surface-elevated border-b border-border-subtle select-none"
        >
          {expanded ? "Collapse unchanged lines" : "Show all lines"}
        </button>
      )}
      {rows.map((row, i) =>
        row.type === "gap" ? (
          <button
            key={i}
            onClick={() => setExpanded(true)}
            title="Click to expand"
            className="flex w-full items-center px-0 py-0.5 text-[11px] text-text-muted hover:bg-surface-hover select-none"
          >
            <span className="w-[68px] shrink-0 text-center border-r border-border-subtle">⋯</span>
            <span className="px-2 italic">{row.count} unchanged line{row.count === 1 ? "" : "s"}</span>
          </button>
        ) : (
          <div
            key={i}
            className={`flex ${
              row.type === "removed"
                ? "bg-accent-red-dim/30"
                : row.type === "added"
                  ? "bg-accent-green-dim/30"
                  : ""
            }`}
          >
            {/* Old line number */}
            <span className="w-8 shrink-0 text-right pr-1 py-0.5 text-[11px] text-text-muted select-none">
              {row.oldLineNum ?? ""}
            </span>
            {/* New line number */}
            <span className="w-8 shrink-0 text-right pr-2 py-0.5 text-[11px] text-text-muted select-none border-r border-border-subtle">
              {row.newLineNum ?? ""}
            </span>
            {/* Diff marker */}
            <span className={`w-5 shrink-0 text-center py-0.5 select-none font-bold ${
              row.type === "removed"
                ? "text-accent-red"
                : row.type === "added"
                  ? "text-accent-green"
                  : "text-text-muted"
            }`}>
              {row.type === "removed" ? "-" : row.type === "added" ? "+" : " "}
            </span>
            {/* Code content */}
            <span className={`px-2 py-0.5 whitespace-pre flex-1 overflow-x-auto ${
              row.type === "removed"
                ? "text-accent-red line-through opacity-70"
                : row.type === "added"
                  ? "text-text-primary"
                  : "text-text-secondary"
            }`}>
              {row.content || " "}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

// --- Split (side-by-side) diff ---
//
// A real git-style side-by-side: for each visible row, the left column shows
// the old line (or a blank when the change only added on the right) and the
// right column shows the new line (or blank). Adjacent removed/added runs are
// paired so a 1-line change shows as one row with red on the left and green on
// the right, not two stacked rows. Same hunked collapse + "Show all lines"
// toggle as the unified view, so a long file doesn't drown a small change.
type SplitCell =
  | { kind: "empty" }
  | { kind: "unchanged" | "removed" | "added"; lineNum: number; content: string };

type SplitRow =
  | { type: "row"; left: SplitCell; right: SplitCell }
  | { type: "gap"; count: number };

function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let pendingRemoved: DiffLine[] = [];
  let pendingAdded: DiffLine[] = [];

  const flush = () => {
    // Pair consecutive removed/added by index; the longer side spills into
    // half-empty rows so additions and removals stay on their own sides.
    const max = Math.max(pendingRemoved.length, pendingAdded.length);
    for (let i = 0; i < max; i++) {
      const r = pendingRemoved[i];
      const a = pendingAdded[i];
      out.push({
        type: "row",
        left: r
          ? { kind: "removed", lineNum: r.oldLineNum ?? 0, content: r.content }
          : { kind: "empty" },
        right: a
          ? { kind: "added", lineNum: a.newLineNum ?? 0, content: a.content }
          : { kind: "empty" },
      });
    }
    pendingRemoved = [];
    pendingAdded = [];
  };

  for (const row of rows) {
    if (row.type === "gap") {
      flush();
      out.push({ type: "gap", count: row.count });
    } else if (row.type === "unchanged") {
      flush();
      out.push({
        type: "row",
        left: { kind: "unchanged", lineNum: row.oldLineNum ?? 0, content: row.content },
        right: { kind: "unchanged", lineNum: row.newLineNum ?? 0, content: row.content },
      });
    } else if (row.type === "removed") {
      pendingRemoved.push(row);
    } else if (row.type === "added") {
      pendingAdded.push(row);
    }
  }
  flush();
  return out;
}

function SplitCellView({ cell }: { cell: SplitCell }) {
  if (cell.kind === "empty") {
    return <div className="flex bg-surface-elevated/20 min-h-[20px]" />;
  }
  const bg =
    cell.kind === "removed"
      ? "bg-accent-red-dim/30"
      : cell.kind === "added"
        ? "bg-accent-green-dim/30"
        : "";
  const markerColor =
    cell.kind === "removed"
      ? "text-accent-red"
      : cell.kind === "added"
        ? "text-accent-green"
        : "text-text-muted";
  const marker = cell.kind === "removed" ? "-" : cell.kind === "added" ? "+" : " ";
  const contentColor =
    cell.kind === "removed"
      ? "text-accent-red"
      : cell.kind === "added"
        ? "text-text-primary"
        : "text-text-secondary";
  return (
    <div className={`flex min-w-0 ${bg}`}>
      <span className="w-8 shrink-0 text-right pr-1 py-0.5 text-[11px] text-text-muted select-none border-r border-border-subtle">
        {cell.lineNum || ""}
      </span>
      <span className={`w-4 shrink-0 text-center py-0.5 select-none font-bold ${markerColor}`}>
        {marker}
      </span>
      <span className={`px-1 py-0.5 whitespace-pre flex-1 overflow-x-auto ${contentColor}`}>
        {cell.content || " "}
      </span>
    </div>
  );
}

function SplitDiffView({ diff }: { diff: DiffLine[] }) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = useMemo(() => collapseDiff(diff), [diff]);
  const hidesLines = useMemo(() => collapsed.some((r) => r.type === "gap"), [collapsed]);
  const sourceRows: DiffRow[] = expanded ? diff : collapsed;
  const splitRows = useMemo(() => toSplitRows(sourceRows), [sourceRows]);

  return (
    <div className="font-mono text-[13px] leading-[20px] bg-surface-code rounded overflow-hidden">
      {hidesLines && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full text-left px-2 py-1 text-2xs text-text-muted hover:text-text-secondary bg-surface-elevated border-b border-border-subtle select-none"
        >
          {expanded ? "Collapse unchanged lines" : "Show all lines"}
        </button>
      )}
      <div className="grid grid-cols-2 divide-x divide-border-subtle">
        <div className="text-2xs font-semibold text-accent-red px-2 py-1 bg-surface-elevated border-b border-border-subtle">
          Before
        </div>
        <div className="text-2xs font-semibold text-accent-green px-2 py-1 bg-surface-elevated border-b border-border-subtle">
          After
        </div>
      </div>
      {splitRows.map((row, i) =>
        row.type === "gap" ? (
          <button
            key={i}
            onClick={() => setExpanded(true)}
            title="Click to expand"
            className="flex w-full items-center px-0 py-0.5 text-[11px] text-text-muted hover:bg-surface-hover select-none border-y border-border-subtle"
          >
            <span className="w-full text-center italic">
              ⋯ {row.count} unchanged line{row.count === 1 ? "" : "s"}
            </span>
          </button>
        ) : (
          <div key={i} className="grid grid-cols-2 divide-x divide-border-subtle">
            <SplitCellView cell={row.left} />
            <SplitCellView cell={row.right} />
          </div>
        ),
      )}
    </div>
  );
}

export function CodeChangeArtifact({ artifact }: { artifact: Artifact }) {
  const content = artifact.content as CodeChangeContent;

  // Reconstruct `before` from session history when the agent omitted it
  // (commonly: a re-edit mislabeled as changeType="create" with empty before).
  // Without this, a real modification renders as a full-file dump under a
  // "create" banner. The backend present_code_change handler now does the same
  // reconstruction at creation time, but (a) it only applies after an MCP
  // restart, and (b) it can't retroactively heal artifacts already stored. This
  // render-time fallback closes both gaps. In replay mode the artifact store
  // only holds artifacts up to the cursor, so the "most recent prior" is
  // naturally bounded by the replay timeline.
  const allArtifacts = useArtifactStore((s) => s.artifacts);
  const reconstructed = useMemo(() => {
    if (content.before) return null;
    const prior = allArtifacts
      .filter((a) =>
        a.id !== artifact.id &&
        a.type === "code_change" &&
        (a.content as any)?.filePath === content.filePath &&
        typeof (a.content as any)?.after === "string" &&
        (a.content as any).after.length > 0 &&
        a.createdAt < artifact.createdAt,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return prior ? { before: (prior.content as any).after as string, fromId: prior.id as string } : null;
  }, [content.before, content.filePath, artifact.id, artifact.createdAt, allArtifacts]);

  const effectiveBefore = content.before || reconstructed?.before || "";
  // If we synthesized a before, the artifact's "create" label is wrong — it's
  // actually a modification. Reflect that in the banner pill too.
  const effectiveChangeType: "create" | "modify" | "delete" =
    !content.before && reconstructed && content.changeType === "create"
      ? "modify"
      : content.changeType;
  const wasReconstructed = !content.before && !!reconstructed;
  const hasBefore = Boolean(effectiveBefore);

  // Default to split (side-by-side) when there's something to diff against —
  // side-by-side reads as a git-style review surface and is what most users
  // reach for first. Unified and Result are one click away.
  const [viewMode, setViewMode] = useState<"unified" | "split" | "result">(
    hasBefore ? "split" : "result",
  );

  const diff = useMemo(() => {
    if (!effectiveBefore || !content.after) return null;
    return computeLineDiff(effectiveBefore, content.after);
  }, [effectiveBefore, content.after]);

  // Show the human's line comments inline on the code (GitHub-style), keyed by
  // line number — mirrors ResearchArtifact. Code_change comments target a line
  // directly (no finding/step/evidence index).
  const allComments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];
  const commentsByLine = useMemo(() => {
    const map = new Map<number, Comment[]>();
    for (const c of allComments) {
      try {
        const t = c.target as any;
        if (t?.lineStart == null || t?.findingIndex != null || t?.stepIndex != null || t?.evidenceIndex != null) continue;
        const startN = Number(t.lineStart);
        const endN = t.lineEnd == null ? startN : Number(t.lineEnd);
        if (!Number.isFinite(startN) || !Number.isFinite(endN)) continue;
        const start = Math.max(0, Math.floor(startN));
        const end = Math.max(start, Math.floor(endN));
        const safeEnd = Math.min(end, start + 200);
        for (let line = start; line <= safeEnd; line++) {
          const existing = map.get(line) ?? [];
          existing.push(c);
          map.set(line, existing);
        }
      } catch {
        // skip one malformed comment, keep rendering the rest
      }
    }
    return map;
  }, [allComments]);

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
          <span className={`px-1.5 py-0.5 text-2xs font-medium rounded ${changeTypeColors[effectiveChangeType]}`}>
            {effectiveChangeType}
          </span>
          {wasReconstructed && (
            <span
              className="px-1.5 py-0.5 text-2xs rounded bg-accent-violet-dim/40 text-accent-violet"
              title="The agent omitted `before`; the diff was reconstructed from a prior code_change for the same file in this session."
            >
              diff reconstructed
            </span>
          )}
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
        <UnifiedDiffView diff={diff} />
      ) : viewMode === "split" && diff ? (
        <SplitDiffView diff={diff} />
      ) : (
        <CommentableCode
          code={content.after || effectiveBefore}
          lineStart={1}
          filePath={content.filePath}
          artifactId={artifact.id}
          commentsByLine={commentsByLine}
        />
      )}

      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
