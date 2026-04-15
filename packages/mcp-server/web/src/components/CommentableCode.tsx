import { useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useHighlightedCode } from "../hooks/useHighlightedCode";
import { detectLanguage } from "../lib/highlighter";

interface CommentableCodeProps {
  code: string;
  language?: string;
  lineStart?: number;
  filePath?: string;
  artifactId: string;
  /** Existing comments keyed by line number */
  commentsByLine?: Map<number, Comment[]>;
  /** Additional context for the comment target */
  targetContext?: {
    findingIndex?: number;
    evidenceIndex?: number;
    stepIndex?: number;
  };
}

export function CommentableCode({
  code,
  language,
  lineStart = 1,
  filePath,
  artifactId,
  commentsByLine,
  targetContext,
}: CommentableCodeProps) {
  const [activeCommentLine, setActiveCommentLine] = useState<number | null>(null);
  const [commentText, setCommentText] = useState("");
  const [suggestMode, setSuggestMode] = useState(false);
  const [suggestionText, setSuggestionText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { submitComment } = useArtifactStore();
  

  const safeCode = code ?? "";
  const resolvedLang = language ?? (filePath ? detectLanguage(filePath) : "text");
  const { lines: highlightedLines } = useHighlightedCode(safeCode, resolvedLang);
  const plainLines = safeCode.split("\n");
  const lines = plainLines;

  const handleSubmit = async (lineNum: number) => {
    if (submitting) return;

    if (suggestMode) {
      if (!suggestionText.trim()) return;
      setSubmitting(true);
      const original = lines[lineNum - lineStart] ?? "";
      await submitComment(
        artifactId,
        `Suggestion: replace line ${lineNum}\n\`\`\`\n${original}\n\`\`\`\nwith:\n\`\`\`\n${suggestionText}\n\`\`\``,
        {
          lineStart: lineNum,
          lineEnd: lineNum,
          filePath,
          suggestion: suggestionText,
          ...targetContext,
        },
      );
    } else {
      if (!commentText.trim()) return;
      setSubmitting(true);
      await submitComment(
        artifactId,
        commentText.trim(),
        {
          lineStart: lineNum,
          lineEnd: lineNum,
          filePath,
          ...targetContext,
        },
      );
    }

    setCommentText("");
    setSuggestionText("");
    setSuggestMode(false);
    setActiveCommentLine(null);
    setSubmitting(false);
  };

  const openCommentLine = (lineNum: number) => {
    setActiveCommentLine(lineNum);
    setCommentText("");
    setSuggestionText("");
    setSuggestMode(false);
  };

  const closeCommentLine = () => {
    setActiveCommentLine(null);
    setCommentText("");
    setSuggestionText("");
    setSuggestMode(false);
  };

  return (
    <div className="font-mono text-[13px] leading-[20px] bg-surface-code rounded overflow-hidden">
      {lines.map((line, i) => {
        const lineNum = lineStart + i;
        const lineComments = commentsByLine?.get(lineNum) ?? [];
        const isCommentActive = activeCommentLine === lineNum;

        return (
          <div key={i}>
            {/* Code line */}
            <div className="flex group">
              {/* Gutter with + icon */}
              <div className="w-10 shrink-0 flex items-center justify-end pr-1 select-none">
                <button
                  onClick={() => {
                    if (isCommentActive) {
                      closeCommentLine();
                    } else {
                      openCommentLine(lineNum);
                    }
                  }}
                  className={`w-4 h-4 flex items-center justify-center rounded text-[10px] transition-all ${
                    isCommentActive || lineComments.length > 0
                      ? "bg-blue-500 text-white"
                      : "opacity-0 group-hover:opacity-100 bg-blue-500/80 text-white hover:bg-blue-600"
                  }`}
                  title="Add comment on this line"
                >
                  {lineComments.length > 0 ? lineComments.length : "+"}
                </button>
              </div>

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

            {/* Existing comments on this line */}
            {lineComments.length > 0 && !isCommentActive && (
              <div
                className="ml-[4.5rem] mr-3 my-1 cursor-pointer"
                onClick={() => openCommentLine(lineNum)}
              >
                {lineComments.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-start gap-2 px-3 py-1.5 bg-accent-blue-dim/60 rounded text-xs mb-0.5"
                  >
                    <span className={`font-semibold shrink-0 ${c.author === "human" ? "text-accent-blue" : "text-text-muted"}`}>
                      {c.author === "human" ? "You" : "Agent"}:
                    </span>
                    <span className="text-text-secondary">{c.content}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Inline comment input */}
            {isCommentActive && (
              <div className="ml-[4.5rem] mr-3 my-1.5">
                {/* Show existing comments in the expanded view */}
                {lineComments.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {lineComments.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-start gap-2 px-3 py-1.5 bg-accent-blue-dim/60 rounded text-xs"
                      >
                        <span className={`font-semibold shrink-0 ${c.author === "human" ? "text-accent-blue" : "text-text-muted"}`}>
                          {c.author === "human" ? "You" : "Agent"}:
                        </span>
                        <span className="text-text-secondary">{c.content}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Mode tabs */}
                <div className="flex items-center gap-1 mb-1.5">
                  <button
                    onClick={() => setSuggestMode(false)}
                    className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors ${
                      !suggestMode ? "bg-accent-blue-dim text-accent-blue" : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    Comment
                  </button>
                  <button
                    onClick={() => {
                      setSuggestMode(true);
                      if (!suggestionText) {
                        setSuggestionText(lines[lineNum - lineStart] ?? "");
                      }
                    }}
                    className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors ${
                      suggestMode ? "bg-accent-green-dim text-accent-green" : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    Suggest
                  </button>
                </div>

                {suggestMode ? (
                  <div className="space-y-1.5">
                    <textarea
                      value={suggestionText}
                      onChange={(e) => setSuggestionText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          handleSubmit(lineNum);
                        }
                        if (e.key === "Escape") closeCommentLine();
                      }}
                      disabled={submitting}
                      autoFocus
                      rows={3}
                      className="w-full px-2.5 py-1.5 bg-surface-secondary border border-accent-green/30 rounded text-xs text-text-primary font-mono
                                 resize-none focus:outline-none focus:ring-1 focus:ring-accent-green"
                    />
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleSubmit(lineNum)}
                        disabled={!suggestionText.trim() || submitting}
                        className="px-2.5 py-1.5 bg-accent-green text-white text-xs rounded
                                   hover:bg-accent-green/80 disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
                      >
                        Submit Suggestion
                      </button>
                      <button onClick={closeCommentLine} className="px-2 py-1.5 text-text-muted text-xs hover:text-text-secondary transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      placeholder="Add a comment on this line..."
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSubmit(lineNum);
                        }
                        if (e.key === "Escape") closeCommentLine();
                      }}
                      disabled={submitting}
                      autoFocus
                      className="flex-1 px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                                 placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <button
                      onClick={() => handleSubmit(lineNum)}
                      disabled={!commentText.trim() || submitting}
                      className="px-2.5 py-1.5 bg-blue-600 text-white text-xs rounded
                                 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-text-muted transition-all duration-[180ms] ease-out press-scale"
                    >
                      Comment
                    </button>
                    <button onClick={closeCommentLine} className="px-2 py-1.5 text-text-muted text-xs hover:text-text-secondary transition-colors">
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
