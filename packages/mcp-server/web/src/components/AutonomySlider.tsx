import { useState, useEffect } from "react";
import { API_BASE, sessionHeaders } from "../lib/api";

type AutonomyLevel = "supervised" | "balanced" | "autonomous";

/**
 * Q6: displayed as a "Ceremony" dial rather than "Autonomy." The underlying
 * values (supervised / balanced / autonomous) stay the same for wire
 * compatibility with existing sessions and daemon state — this is purely
 * a label change so the control reads as a collaboration dial, not a
 * kill-switch.
 */
const levels: { id: AutonomyLevel; label: string; description: string }[] = [
  { id: "supervised", label: "Full",    description: "Full ceremony — every finding, option, plan, and change gets structured review" },
  { id: "balanced",   label: "Light",   description: "Skip findings for simple tasks; options only on genuine tradeoffs" },
  { id: "autonomous", label: "Minimal", description: "Agent proceeds with its recommendations; you review after" },
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
        headers: sessionHeaders(),
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
        title="Ceremony level"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <circle cx="6" cy="6" r="4.5" />
          <path d="M3.5 6h5M6 3.5v5" />
        </svg>
        Ceremony: {levels[currentIdx].label}
      </button>

      {showTooltip && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowTooltip(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-border-subtle">
              <div className="text-xs font-medium text-text-primary">Ceremony level</div>
              <div className="text-2xs text-text-muted">How much structured review the pair should do</div>
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
