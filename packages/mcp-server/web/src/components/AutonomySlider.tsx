import { useState, useEffect } from "react";

const API_BASE = `http://${window.location.host}`;

type AutonomyLevel = "supervised" | "balanced" | "autonomous";

const levels: { id: AutonomyLevel; label: string; description: string }[] = [
  { id: "supervised", label: "Supervised", description: "Full ceremony — findings, options, plan, approval" },
  { id: "balanced", label: "Balanced", description: "Skip findings for simple tasks, options for genuine choices only" },
  { id: "autonomous", label: "Autonomous", description: "Agent proceeds with recommendations, you review after" },
];

export function AutonomySlider() {
  const [level, setLevel] = useState<AutonomyLevel>("supervised");
  const [showTooltip, setShowTooltip] = useState(false);

  // Load from server on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/state`)
      .then((r) => r.json())
      .then((state) => {
        if (state.autonomyLevel) setLevel(state.autonomyLevel);
      })
      .catch(() => {});
  }, []);

  const handleChange = async (newLevel: AutonomyLevel) => {
    setLevel(newLevel);
    try {
      await fetch(`${API_BASE}/api/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autonomyLevel: newLevel }),
      });
    } catch {
      // Failed to save — UI still reflects the change
    }
  };

  const currentIdx = levels.findIndex((l) => l.id === level);

  return (
    <div className="relative">
      <button
        onClick={() => setShowTooltip(!showTooltip)}
        className="flex items-center gap-1.5 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title="Autonomy level"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <circle cx="6" cy="6" r="4.5" />
          <path d="M3.5 6h5M6 3.5v5" />
        </svg>
        {levels[currentIdx].label}
      </button>

      {showTooltip && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowTooltip(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-border-subtle">
              <div className="text-xs font-medium text-text-primary">Involvement Level</div>
              <div className="text-2xs text-text-muted">How much ceremony should the agent use?</div>
            </div>
            {levels.map((l) => (
              <button
                key={l.id}
                onClick={() => { handleChange(l.id); setShowTooltip(false); }}
                className={`w-full text-left px-3 py-2 transition-colors ${
                  l.id === level
                    ? "bg-accent-blue-dim/40 text-accent-blue"
                    : "hover:bg-surface-hover text-text-secondary"
                }`}
              >
                <div className="text-xs font-medium">{l.label}</div>
                <div className="text-2xs text-text-muted">{l.description}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
