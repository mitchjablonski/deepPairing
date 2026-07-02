import { useState, useEffect } from "react";
import { apiBase, sessionHeaders, apiGet } from "../lib/api";
import { useToastStore } from "../stores/toast";

type AutonomyLevel = "supervised" | "balanced" | "autonomous";

/**
 * Q6 + III9: was displayed as a "Ceremony" dial. Council product review
 * flagged "ceremony" as the single most off-brand word in the doc for
 * the senior-IC audience — it reads as overhead being sold, the opposite
 * of the promise. Renamed to "Autonomy" everywhere a user sees it.
 * Underlying wire values (supervised / balanced / autonomous) stay the
 * same for compatibility with existing sessions, daemon state, and the
 * /api/preferences route.
 */
const levels: { id: AutonomyLevel; label: string; description: string }[] = [
  { id: "supervised", label: "Full",    description: "Every finding, option, plan, and change gets structured review" },
  { id: "balanced",   label: "Light",   description: "Skip findings for simple tasks; options only on genuine tradeoffs" },
  { id: "autonomous", label: "Minimal", description: "Agent proceeds with its recommendations; you review after" },
];

export function AutonomySlider() {
  const [level, setLevel] = useState<AutonomyLevel>("supervised");
  const [showTooltip, setShowTooltip] = useState(false);

  // Load from server on mount
  useEffect(() => {
    apiGet(`${apiBase()}/api/state`)
      .then((r) => r.json())
      .then((state) => {
        if (state.autonomyLevel) setLevel(state.autonomyLevel);
      })
      .catch(() => {});
  }, []);

  const handleChange = async (newLevel: AutonomyLevel) => {
    const prev = level;
    setLevel(newLevel);
    // C1 — this control GOVERNS THE AUTO-APPROVE COUNTDOWN: silently keeping
    // the optimistic value on a failed save meant a user who dialed autonomy
    // down on a dead daemon believed auto-approve was off when it wasn't.
    // Roll back + toast like every other mutation.
    try {
      const res = await fetch(`${apiBase()}/api/preferences`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({ autonomyLevel: newLevel }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // C1 review — only roll back if the display still shows THIS request's
      // optimistic value; a rapid A→B→C where B's save fails after C's
      // succeeded must not clobber C back to A.
      setLevel((cur) => (cur === newLevel ? prev : cur));
      useToastStore.getState().push({
        kind: "error",
        title: "Autonomy level not saved",
        body: "It still controls auto-approve, so the change was rolled back.",
      });
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
        Autonomy: {levels[currentIdx].label}
      </button>

      {showTooltip && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowTooltip(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-border-subtle">
              <div className="text-xs font-medium text-text-primary">Autonomy level</div>
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
