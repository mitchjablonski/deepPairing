import { useEffect, useRef, useState, useCallback } from "react";
import { useArtifactStore } from "../../stores/artifact";

interface FileViewerProps {
  filePath: string;
  highlightStart?: number;
  highlightEnd?: number;
  /** Artifact ID for anchoring comments */
  artifactId?: string;
  onClose: () => void;
}

export function FileViewer({
  filePath,
  highlightStart,
  highlightEnd,
  artifactId,
  onClose,
}: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  

  // Line selection state
  const [selectStart, setSelectStart] = useState<number | null>(null);
  const [selectEnd, setSelectEnd] = useState<number | null>(null);
  const [commentText, setCommentText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { submitComment } = useArtifactStore();

  useEffect(() => {
    setLoading(true);
    // In the companion UI, files are read by Claude Code — no server-side file cache
    fetch(`/api/files?path=${encodeURIComponent(filePath)}`)
      .then((res) => {
        if (!res.ok) throw new Error("File not cached");
        return res.json();
      })
      .then((data) => setContent(data.content))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [filePath]);

  useEffect(() => {
    if (content && highlightRef.current) {
      highlightRef.current.scrollIntoView?.({ behavior: "smooth", block: "center" });
    }
  }, [content]);

  const handleLineClick = useCallback(
    (lineNum: number, shiftKey: boolean) => {
      if (shiftKey && selectStart != null) {
        // Extend selection
        setSelectEnd(lineNum);
      } else {
        // Start new selection
        setSelectStart(lineNum);
        setSelectEnd(lineNum);
      }
    },
    [selectStart],
  );

  const clearSelection = () => {
    setSelectStart(null);
    setSelectEnd(null);
    setCommentText("");
  };

  const selectionRange =
    selectStart != null && selectEnd != null
      ? { start: Math.min(selectStart, selectEnd), end: Math.max(selectStart, selectEnd) }
      : null;

  const lines = content?.split("\n") ?? [];

  const getSelectedSnippet = (): string => {
    if (!selectionRange) return "";
    return lines.slice(selectionRange.start - 1, selectionRange.end).join("\n");
  };

  const handleSubmitComment = async () => {
    if (!commentText.trim() || !artifactId || !selectionRange) return;
    setSubmitting(true);

    await submitComment(
      artifactId,
      commentText.trim(),
      {
        lineStart: selectionRange.start,
        lineEnd: selectionRange.end,
        filePath,
      },
    );

    setCommentText("");
    setSubmitting(false);
    clearSelection();
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-8 text-sm text-gray-500">Loading file...</div>
      </div>
    );
  }

  if (error || !content) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 max-w-sm">
          <p className="text-sm text-red-600 mb-3">
            {error ?? "File not available"} — the agent hasn't read this file yet.
          </p>
          <button onClick={onClose} className="px-3 py-1.5 bg-gray-100 text-sm rounded hover:bg-gray-200">
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-8">
      <div className="bg-white rounded-lg shadow-xl flex flex-col max-w-4xl w-full max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50 rounded-t-lg">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono font-medium text-gray-800">{filePath}</span>
            <span className="text-xs text-gray-400">{lines.length} lines</span>
            {highlightStart != null && highlightEnd != null && (
              <span className="px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">
                Evidence: L{highlightStart}-{highlightEnd}
              </span>
            )}
            {selectionRange && (
              <span className="px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">
                Selected: L{selectionRange.start}-{selectionRange.end}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectionRange && (
              <button
                onClick={clearSelection}
                className="px-2 py-1 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded"
              >
                Clear selection
              </button>
            )}
            <button
              onClick={onClose}
              className="px-2 py-1 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded"
            >
              Close
            </button>
          </div>
        </div>

        {/* Instruction hint */}
        {!selectionRange && (
          <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100 text-xs text-blue-600">
            Click a line number to select it. Shift-click to select a range. Then add a comment.
          </div>
        )}

        {/* File content */}
        <div className="flex-1 overflow-auto">
          <pre className="text-xs font-mono leading-5">
            {lines.map((line, i) => {
              const lineNum = i + 1;
              const isEvidenceHighlight =
                highlightStart != null &&
                highlightEnd != null &&
                lineNum >= highlightStart &&
                lineNum <= highlightEnd;
              const isSelected =
                selectionRange != null &&
                lineNum >= selectionRange.start &&
                lineNum <= selectionRange.end;

              return (
                <div
                  key={i}
                  ref={isEvidenceHighlight && lineNum === highlightStart ? highlightRef : undefined}
                  className={`flex ${
                    isSelected
                      ? "bg-blue-50 border-l-2 border-blue-500"
                      : isEvidenceHighlight
                        ? "bg-amber-50 border-l-2 border-amber-400"
                        : "hover:bg-gray-50 border-l-2 border-transparent"
                  }`}
                >
                  <span
                    onClick={(e) => handleLineClick(lineNum, e.shiftKey)}
                    className={`w-12 shrink-0 text-right pr-3 py-0.5 select-none border-r border-gray-100 cursor-pointer hover:bg-blue-100 hover:text-blue-700 transition-colors ${
                      isSelected ? "text-blue-600 font-semibold" : "text-gray-400"
                    }`}
                  >
                    {lineNum}
                  </span>
                  <span className={`px-3 py-0.5 whitespace-pre flex-1 ${
                    isSelected ? "text-gray-900" : isEvidenceHighlight ? "text-gray-900" : "text-gray-700"
                  }`}>
                    {line || " "}
                  </span>
                </div>
              );
            })}
          </pre>
        </div>

        {/* Comment input — appears when lines are selected */}
        {selectionRange && artifactId && (
          <div className="border-t border-gray-200 p-3 bg-gray-50 rounded-b-lg">
            <div className="mb-2">
              <div className="text-xs text-gray-500 mb-1">
                Comment on <span className="font-mono font-medium text-blue-700">L{selectionRange.start}-{selectionRange.end}</span>:
              </div>
              <pre className="text-xs font-mono bg-white border border-gray-200 rounded p-2 max-h-20 overflow-auto text-gray-600">
                {getSelectedSnippet()}
              </pre>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Add your comment about these lines..."
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmitComment();
                  }
                  if (e.key === "Escape") clearSelection();
                }}
                disabled={submitting}
                autoFocus
                className="flex-1 px-3 py-2 border border-gray-300 rounded text-xs
                           focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
              />
              <button
                onClick={handleSubmitComment}
                disabled={!commentText.trim() || submitting}
                className="px-3 py-2 bg-blue-600 text-white text-xs font-medium rounded
                           hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
              >
                Comment
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
