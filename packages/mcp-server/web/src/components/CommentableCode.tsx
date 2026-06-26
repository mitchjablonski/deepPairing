import { useState } from "react";
import type { Comment, PlanVisualAnnotation } from "@deeppairing/shared";
import { useHighlightedCode } from "../hooks/useHighlightedCode";
import { detectLanguage } from "../lib/highlighter";
import { LineGutter, LineCommentChips, LineComposer, type LineMode } from "./LineComments";

/** Presentational treatment for an agent annotation marker, by semantic kind. */
const annStyle: Record<string, { glyph: string; cls: string }> = {
  add: { glyph: "+", cls: "text-accent-green" },
  remove: { glyph: "−", cls: "text-accent-red" },
  change: { glyph: "~", cls: "text-accent-amber" },
  context: { glyph: "›", cls: "text-text-muted" },
};

interface CommentableCodeProps {
  code: string;
  language?: string;
  lineStart?: number;
  filePath?: string;
  artifactId: string;
  /** Existing comments keyed by line number */
  commentsByLine?: Map<number, Comment[]>;
  /** Agent annotations keyed by absolute line number — rendered as a callout
   *  under the line (the agent's voice, distinct from human comments). */
  annotationsByLine?: Map<number, PlanVisualAnnotation[]>;
  /** Additional context for the comment target */
  targetContext?: {
    findingIndex?: number;
    evidenceIndex?: number;
    stepIndex?: number;
    visualId?: string;
  };
  /** Render the code + annotations but WITHOUT the interactive comment gutter.
   *  Used by the revision diff, which is a preview — a comment started there
   *  would anchor to the wrong (new) artifact version. */
  readOnly?: boolean;
}

export function CommentableCode({
  code,
  language,
  lineStart = 1,
  filePath,
  artifactId,
  commentsByLine,
  annotationsByLine,
  targetContext,
  readOnly = false,
}: CommentableCodeProps) {
  // One open composer at a time across the whole block. Mode lives here too so
  // the gutter and composer agree on which tab is active.
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [mode, setMode] = useState<LineMode>("comment");

  const safeCode = code ?? "";
  const resolvedLang = language ?? (filePath ? detectLanguage(filePath) : "text");
  const { lines: highlightedLines } = useHighlightedCode(safeCode, resolvedLang);
  const lines = safeCode.split("\n");
  const totalLines = lineStart + lines.length - 1;

  const openLine = (lineNum: number, initialMode: LineMode = "comment") => {
    setActiveLine(lineNum);
    setMode(initialMode);
  };
  const closeLine = () => setActiveLine(null);

  return (
    <div className="font-mono text-[13px] leading-[20px] bg-surface-code rounded overflow-hidden">
      {lines.map((line, i) => {
        const lineNum = lineStart + i;
        const lineComments = commentsByLine?.get(lineNum) ?? [];
        const isCommentActive = activeLine === lineNum;

        // X10 — anchor key matches commentAnchorKey() in lib/comment-anchor.ts.
        const anchorKey = `line:${filePath ?? ""}:${lineNum}`;

        return (
          <div key={i} data-comment-anchor={anchorKey}>
            {/* Code line */}
            <div className="flex group">
              {readOnly ? (
                // Preview (revision diff): no interactive gutter — a comment
                // here would anchor to the wrong version. Keep the width so the
                // code stays aligned with the live view.
                <div className="w-14 shrink-0 pr-1" />
              ) : (
                <LineGutter
                  lineNum={lineNum}
                  commentCount={lineComments.length}
                  active={isCommentActive}
                  activeMode={mode}
                  onOpen={(m) => openLine(lineNum, m)}
                  onClose={closeLine}
                  className="w-14 shrink-0 pr-1"
                />
              )}

              {/* Line number */}
              <span className="w-8 shrink-0 text-right pr-2 py-0.5 text-text-muted select-none border-r border-border-subtle text-[11px]">
                {lineNum}
              </span>

              {/* Code content — syntax highlighted when available, never truncated */}
              {highlightedLines?.[i] ? (
                <span
                  className="px-3 py-0.5 whitespace-pre flex-1 overflow-x-auto"
                  dangerouslySetInnerHTML={{ __html: highlightedLines[i] || "&nbsp;" }}
                />
              ) : (
                <span className="px-3 py-0.5 whitespace-pre flex-1 text-text-primary overflow-x-auto">
                  {line || " "}
                </span>
              )}
            </div>

            {/* Agent annotations on this line — the planning voice ("here's the
                line that changes, and why"), styled distinctly from human
                comments so the two don't blur together. */}
            {(annotationsByLine?.get(lineNum) ?? []).map((a, ai) => {
              const s = annStyle[a.kind ?? "context"] ?? annStyle.context;
              return (
                <div
                  key={`ann-${ai}`}
                  className="ml-[5.5rem] mr-3 my-1 flex items-start gap-1.5 px-2 py-1 rounded bg-accent-violet-dim/15 border-l-2 border-accent-violet/40"
                >
                  <span className={`shrink-0 font-bold text-2xs ${s.cls}`}>{s.glyph}</span>
                  <span className="text-2xs text-text-secondary whitespace-pre-wrap">{a.note}</span>
                </div>
              );
            })}

            {/* Existing comments on this line (collapsed/threaded) — hidden
                while the composer is open since the composer shows them too. */}
            {lineComments.length > 0 && !isCommentActive && (
              <div className="ml-[5.5rem] mr-3 my-1">
                <LineCommentChips
                  lineNum={lineNum}
                  comments={lineComments}
                  artifactId={artifactId}
                  filePath={filePath}
                  onOpenLine={() => openLine(lineNum)}
                />
              </div>
            )}

            {/* Inline composer */}
            {isCommentActive && (
              <LineComposer
                lineNum={lineNum}
                totalLines={lines.length}
                maxLine={totalLines}
                artifactId={artifactId}
                filePath={filePath}
                lineText={lines[lineNum - lineStart] ?? ""}
                mode={mode}
                setMode={setMode}
                existingComments={lineComments}
                targetContext={targetContext}
                onClose={closeLine}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
