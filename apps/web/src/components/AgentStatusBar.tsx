import { useEffect, useState } from "react";
import { useSessionStore } from "../stores/session";

const phaseLabels: Record<string, { label: string; color: string }> = {
  idle:       { label: "Idle",       color: "bg-gray-200 text-gray-700" },
  connecting: { label: "Connecting", color: "bg-blue-100 text-blue-700" },
  gathering:  { label: "Gathering",  color: "bg-amber-100 text-amber-700" },
  presenting: { label: "Presenting", color: "bg-purple-100 text-purple-700" },
  executing:  { label: "Executing",  color: "bg-green-100 text-green-700" },
  completed:  { label: "Completed",  color: "bg-green-200 text-green-800" },
  error:      { label: "Error",      color: "bg-red-100 text-red-700" },
};

export function AgentStatusBar() {
  const { status, events, stopSession } = useSessionStore();
  const [elapsed, setElapsed] = useState(0);
  const [startTime] = useState(() => Date.now());

  const isActive = status !== "idle" && status !== "completed" && status !== "error";

  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive, startTime]);

  const toolCallCount = events.filter((e) => e.type === "tool_call").length;
  const phase = phaseLabels[status] ?? phaseLabels.idle;

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-gray-50 border-b border-gray-200 text-xs">
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium ${phase.color}`}>
          {isActive && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
          )}
          {phase.label}
        </span>
        {isActive && (
          <span className="text-gray-400 tabular-nums">{formatTime(elapsed)}</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-gray-500">
          {toolCallCount} tool call{toolCallCount !== 1 ? "s" : ""}
        </span>
        <span className="text-gray-500">{events.length} events</span>
        {isActive && (
          <button
            onClick={(e) => { e.stopPropagation(); stopSession(); }}
            className="px-2 py-0.5 bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors font-medium"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
