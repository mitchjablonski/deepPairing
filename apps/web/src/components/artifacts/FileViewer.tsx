import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../stores/session";

interface FileViewerProps {
  filePath: string;
  highlightStart?: number;
  highlightEnd?: number;
  onClose: () => void;
}

export function FileViewer({
  filePath,
  highlightStart,
  highlightEnd,
  onClose,
}: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [_language, setLanguage] = useState("text");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const sessionId = useSessionStore((s) => s.sessionId);

  useEffect(() => {
    if (!sessionId) return;

    setLoading(true);
    fetch(`/api/sessions/${sessionId}/files?path=${encodeURIComponent(filePath)}`)
      .then((res) => {
        if (!res.ok) throw new Error("File not cached");
        return res.json();
      })
      .then((data) => {
        setContent(data.content);
        setLanguage(data.language);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId, filePath]);

  // Scroll to highlighted lines
  useEffect(() => {
    if (content && highlightRef.current) {
      highlightRef.current.scrollIntoView?.({ behavior: "smooth", block: "center" });
    }
  }, [content]);

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

  const lines = content.split("\n");

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-8">
      <div className="bg-white rounded-lg shadow-xl flex flex-col max-w-4xl w-full max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50 rounded-t-lg">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono font-medium text-gray-800">{filePath}</span>
            <span className="text-xs text-gray-400">{lines.length} lines</span>
            {highlightStart && highlightEnd && (
              <span className="px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">
                L{highlightStart}-{highlightEnd} highlighted
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="px-2 py-1 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded"
          >
            Close
          </button>
        </div>

        {/* File content */}
        <div className="flex-1 overflow-auto">
          <pre className="text-xs font-mono leading-5">
            {lines.map((line, i) => {
              const lineNum = i + 1;
              const isHighlighted =
                highlightStart != null &&
                highlightEnd != null &&
                lineNum >= highlightStart &&
                lineNum <= highlightEnd;

              return (
                <div
                  key={i}
                  ref={isHighlighted && lineNum === highlightStart ? highlightRef : undefined}
                  className={`flex ${isHighlighted ? "bg-amber-50 border-l-2 border-amber-400" : "hover:bg-gray-50"}`}
                >
                  <span className="w-12 shrink-0 text-right pr-3 py-0.5 text-gray-400 select-none border-r border-gray-100">
                    {lineNum}
                  </span>
                  <span className={`px-3 py-0.5 whitespace-pre flex-1 ${isHighlighted ? "text-gray-900" : "text-gray-700"}`}>
                    {line || " "}
                  </span>
                </div>
              );
            })}
          </pre>
        </div>
      </div>
    </div>
  );
}
