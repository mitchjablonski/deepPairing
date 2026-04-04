import { useEffect, useState } from "react";
import type { AgentEvent } from "@deeppairing/shared";

const API_BASE = "http://localhost:3001";

interface ForkData {
  id: string;
  decisionId: string;
  optionId: string;
  status: string;
  events: AgentEvent[];
  worktreePath: string | null;
}

interface ComparisonViewProps {
  sessionId: string;
}

export function ComparisonView({ sessionId }: ComparisonViewProps) {
  const [forks, setForks] = useState<Array<{ id: string; decisionId: string; optionId: string; status: string }>>([]);
  const [selectedFork, setSelectedFork] = useState<ForkData | null>(null);
  const [diff, setDiff] = useState<string>("");

  useEffect(() => {
    fetch(`${API_BASE}/api/sessions/${sessionId}/forks`)
      .then((res) => res.json())
      .then((data) => setForks(data.forks ?? []))
      .catch(() => {});
  }, [sessionId]);

  const loadFork = async (forkId: string) => {
    const [forkRes, diffRes] = await Promise.all([
      fetch(`${API_BASE}/api/forks/${forkId}`),
      fetch(`${API_BASE}/api/forks/${forkId}/diff`),
    ]);

    const forkData = await forkRes.json();
    const diffData = await diffRes.json();

    setSelectedFork(forkData);
    setDiff(diffData.diff ?? "");
  };

  if (forks.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-gray-200">
      <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50 border-b border-gray-200">
        Explorations ({forks.length})
      </div>

      {/* Fork list */}
      <div className="flex gap-1 p-2 overflow-x-auto">
        {forks.map((fork) => (
          <button
            key={fork.id}
            onClick={() => loadFork(fork.id)}
            className={`shrink-0 px-3 py-1.5 text-xs rounded-md border transition-colors ${
              selectedFork?.id === fork.id
                ? "border-blue-400 bg-blue-50 text-blue-700"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
            }`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${
              fork.status === "completed" ? "bg-green-500" :
              fork.status === "running" ? "bg-amber-500 animate-pulse" :
              fork.status === "error" ? "bg-red-500" :
              "bg-gray-400"
            }`} />
            {fork.optionId}
          </button>
        ))}
      </div>

      {/* Selected fork details */}
      {selectedFork && (
        <div className="p-3 border-t border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-700">
              Fork: {selectedFork.id}
            </span>
            <span className={`px-1.5 py-0.5 text-xs rounded ${
              selectedFork.status === "completed"
                ? "bg-green-100 text-green-700"
                : "bg-amber-100 text-amber-700"
            }`}>
              {selectedFork.status}
            </span>
          </div>

          {/* Events summary */}
          <div className="text-xs text-gray-500 mb-2">
            {selectedFork.events.length} events •
            {selectedFork.events.filter((e) => e.type === "tool_call").length} tool calls
          </div>

          {/* Diff */}
          {diff && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-1">Changes</div>
              <pre className="text-xs bg-gray-50 rounded p-2 overflow-auto max-h-60 whitespace-pre-wrap font-mono">
                {diff}
              </pre>
            </div>
          )}

          {!diff && selectedFork.status === "completed" && (
            <p className="text-xs text-gray-400 italic">No file changes in this exploration</p>
          )}
        </div>
      )}
    </div>
  );
}
