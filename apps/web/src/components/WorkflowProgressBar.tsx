import { useSessionStore } from "../stores/session";

const phases = [
  { key: "gathering", label: "Gather", icon: "🔍" },
  { key: "presenting", label: "Decide", icon: "⚖️" },
  { key: "executing", label: "Execute", icon: "⚡" },
] as const;

const phaseOrder = phases.map((p) => p.key);

export function WorkflowProgressBar() {
  const status = useSessionStore((s) => s.status);

  if (status === "idle") return null;

  const currentIdx = phaseOrder.indexOf(status as any);

  return (
    <div className="flex items-center gap-0.5 px-3">
      {phases.map((phase, idx) => {
        const isCompleted = currentIdx > idx;
        const isCurrent = phase.key === status;
        const isUnknown = currentIdx === -1; // completed/error/connecting

        return (
          <div key={phase.key} className="flex items-center gap-0.5 flex-1">
            {/* Phase segment */}
            <div
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium transition-all ${
                isCurrent
                  ? "bg-accent-blue-dim text-accent-blue"
                  : isCompleted
                    ? "bg-accent-green-dim/50 text-accent-green"
                    : isUnknown
                      ? "bg-surface-elevated text-text-muted"
                      : "text-text-muted"
              }`}
            >
              {isCurrent && (
                <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
              )}
              {isCompleted && (
                <span className="text-accent-green text-[10px]">✓</span>
              )}
              <span>{phase.label}</span>
            </div>

            {/* Connector line */}
            {idx < phases.length - 1 && (
              <div
                className={`flex-1 h-px ${
                  isCompleted ? "bg-accent-green/30" : "bg-border-subtle"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
