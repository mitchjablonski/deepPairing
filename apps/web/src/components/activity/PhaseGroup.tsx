import { useState, type ReactNode } from "react";

const phaseConfig: Record<string, { label: string; color: string }> = {
  gathering: { label: "Gathering", color: "text-accent-amber" },
  presenting: { label: "Presenting", color: "text-accent-violet" },
  executing: { label: "Executing", color: "text-accent-green" },
  idle: { label: "Idle", color: "text-text-muted" },
};

interface PhaseGroupProps {
  phase: string;
  eventCount: number;
  isLatest: boolean;
  children: ReactNode;
}

export function PhaseGroup({ phase, eventCount, isLatest, children }: PhaseGroupProps) {
  const [collapsed, setCollapsed] = useState(!isLatest);
  const config = phaseConfig[phase] ?? { label: phase, color: "text-text-muted" };

  return (
    <div className="mb-1">
      {/* Phase header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 w-full px-3 py-1 hover:bg-surface-hover transition-colors"
      >
        <div className="flex-1 border-t border-border-subtle" />
        <span className={`text-2xs font-semibold uppercase tracking-wider ${config.color}`}>
          {config.label}
        </span>
        <span className="text-2xs text-text-muted tabular-nums">{eventCount}</span>
        <span className="text-2xs text-text-muted">{collapsed ? "▶" : "▼"}</span>
        <div className="flex-1 border-t border-border-subtle" />
      </button>

      {/* Phase content */}
      {!collapsed && (
        <div className="py-1">
          {children}
        </div>
      )}
    </div>
  );
}
