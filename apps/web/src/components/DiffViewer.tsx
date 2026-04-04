import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import type { CodeChangeEvent } from "@deeppairing/shared";

interface DiffViewerProps {
  change: CodeChangeEvent;
}

/**
 * Parses a unified diff to extract original and modified content.
 */
function parseDiff(diff: string): { original: string; modified: string } {
  const lines = diff.split("\n");
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith("-")) {
      originalLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      modifiedLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      originalLines.push(line.slice(1));
      modifiedLines.push(line.slice(1));
    } else {
      // Context line without prefix
      originalLines.push(line);
      modifiedLines.push(line);
    }
  }

  return {
    original: originalLines.join("\n"),
    modified: modifiedLines.join("\n"),
  };
}

export function DiffViewer({ change }: DiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Clean up previous editor
    viewRef.current?.destroy();

    const { modified } = parseDiff(change.diff);
    const displayContent = modified || change.diff;

    const state = EditorState.create({
      doc: displayContent,
      extensions: [
        basicSetup,
        javascript({ typescript: true }),
        EditorView.editable.of(false),
        EditorView.theme({
          "&": { fontSize: "13px" },
          ".cm-content": { fontFamily: "ui-monospace, monospace" },
          ".cm-gutters": { backgroundColor: "#f9fafb", borderRight: "1px solid #e5e7eb" },
        }),
      ],
    });

    viewRef.current = new EditorView({
      state,
      parent: containerRef.current,
    });

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [change]);

  return (
    <div className="flex flex-col h-full">
      {/* File header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <span className={`px-1.5 py-0.5 text-xs font-medium rounded ${
            change.changeType === "create" ? "bg-green-100 text-green-700" :
            change.changeType === "delete" ? "bg-red-100 text-red-700" :
            "bg-amber-100 text-amber-700"
          }`}>
            {change.changeType}
          </span>
          <span className="text-sm font-mono text-gray-700">{change.filePath}</span>
        </div>
      </div>

      {/* Reasoning annotation */}
      {change.reasoning && (
        <div className="px-3 py-2 bg-violet-50 border-b border-violet-200 text-xs">
          <span className="font-semibold text-violet-700">Why: </span>
          <span className="text-gray-700">{change.reasoning.reasoning}</span>
          {change.reasoning.alternativesConsidered && change.reasoning.alternativesConsidered.length > 0 && (
            <span className="text-gray-400 ml-2">
              (alternatives: {change.reasoning.alternativesConsidered.join(", ")})
            </span>
          )}
        </div>
      )}

      {/* CodeMirror editor */}
      <div ref={containerRef} className="flex-1 overflow-auto" />
    </div>
  );
}
