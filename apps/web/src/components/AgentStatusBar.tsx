import { useEffect, useState } from "react";
import { useSessionStore } from "../stores/session";

const phaseLabels: Record<string, { label: string; color: string }> = {
  idle:       { label: "Idle",       color: "bg-surface-elevated text-text-muted" },
  connecting: { label: "Connecting", color: "bg-accent-blue-dim text-accent-blue" },
  gathering:  { label: "Gathering",  color: "bg-accent-amber-dim text-accent-amber" },
  presenting: { label: "Presenting", color: "bg-accent-violet-dim text-accent-violet" },
  executing:  { label: "Executing",  color: "bg-accent-green-dim text-accent-green" },
  completed:  { label: "Completed",  color: "bg-accent-green-dim text-accent-green" },
  error:      { label: "Error",      color: "bg-accent-red-dim text-accent-red" },
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
    <div className="flex items-center justify-between px-3 py-1 bg-surface-secondary border-b border-border-default text-xs">
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-medium ${phase.color}`}>
          {isActive && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
          )}
          {phase.label}
        </span>
        {isActive && (
          <span className="text-text-muted tabular-nums text-2xs">{formatTime(elapsed)}</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-text-muted text-2xs">
          {toolCallCount} tool{toolCallCount !== 1 ? "s" : ""}
        </span>
        <span className="text-text-muted text-2xs">{events.length} events</span>
        {isActive && (
          <button
            onClick={(e) => { e.stopPropagation(); stopSession(); }}
            className="px-2 py-0.5 bg-accent-red-dim text-accent-red rounded text-2xs hover:bg-accent-red-dim/80 transition-colors font-medium"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
