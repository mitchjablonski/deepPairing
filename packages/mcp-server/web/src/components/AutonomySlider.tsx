import { useState, useEffect, useRef } from "react";
import { apiBase, sessionHeaders, apiGet } from "../lib/api";
import { useToastStore } from "../stores/toast";

type AutonomyLevel = "supervised" | "balanced" | "autonomous";
type DetailDensity = "rich" | "terse";

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

/**
 * #139 — detail density (verbosity) is ORTHOGONAL to autonomy. Autonomy governs
 * how MANY artifacts post + gating (auto-approve); this governs how much PROSE
 * rides inside each artifact. It lives inside the same popover as a small
 * Rich/Terse toggle — deliberately NOT a second slider, since two "how much"
 * sliders would blur which one controls auto-approve. Terse only trims text:
 * every artifact still posts and Evidence is always attached.
 */
const densities: { id: DetailDensity; label: string; description: string }[] = [
  { id: "rich",  label: "Rich",  description: "Full explanations around each artifact" },
  { id: "terse", label: "Terse", description: "Tight prose; same artifacts + evidence, less text" },
];

export function AutonomySlider() {
  const [level, setLevel] = useState<AutonomyLevel>("supervised");
  // #139 — default "rich" mirrors the store default so an old preferences.json
  // (no detailDensity field) reads as Rich.
  const [density, setDensity] = useState<DetailDensity>("rich");
  const [showTooltip, setShowTooltip] = useState(false);
  // #139 — refs for the detail-density radios so arrow-key navigation can move
  // focus (the WAI-ARIA radiogroup pattern: one tab stop, arrows move+select).
  const densityRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Load from server on mount
  useEffect(() => {
    apiGet(`${apiBase()}/api/state`)
      .then((r) => r.json())
      .then((state) => {
        if (state.autonomyLevel) setLevel(state.autonomyLevel);
        if (state.detailDensity === "rich" || state.detailDensity === "terse") {
          setDensity(state.detailDensity);
        }
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

  // #139 — detail density is orthogonal to autonomy and does NOT gate
  // auto-approve, so a failed save is a soft rollback (toast, no auto-approve
  // safety claim). Mirrors handleChange's optimistic-then-reconcile shape.
  const handleDensityChange = async (newDensity: DetailDensity) => {
    if (newDensity === density) return;
    const prev = density;
    setDensity(newDensity);
    try {
      const res = await fetch(`${apiBase()}/api/preferences`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({ detailDensity: newDensity }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setDensity((cur) => (cur === newDensity ? prev : cur));
      useToastStore.getState().push({
        kind: "error",
        title: "Detail density not saved",
        body: "The change was rolled back.",
      });
    }
  };

  // #139 — WAI-ARIA radiogroup keyboard nav: arrows move focus AND selection
  // (single tab stop via roving tabindex below). Home/End jump to the ends.
  const handleDensityKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") nextIdx = (idx + 1) % densities.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") nextIdx = (idx - 1 + densities.length) % densities.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = densities.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const next = densities[nextIdx]!;
    densityRefs.current[nextIdx]?.focus?.(); // optional chain for jsdom compat
    void handleDensityChange(next.id);
  };

  // The /api/state response isn't schema-validated, so an unknown
  // autonomyLevel used to make this lookup miss and crash the header on
  // render. Fall back to the first (supervised) entry instead.
  const currentLevel = levels.find((l) => l.id === level) ?? levels[0]!; // `!` safe: levels is a non-empty literal

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
        Autonomy: {currentLevel.label}
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

            {/* #139 — detail density. A radiogroup (not a second slider): two
                "how much" sliders would blur which one governs auto-approve.
                Keyboard-operable radios with a real group name + checked state. */}
            <div className="px-3 py-2 border-t border-border-subtle">
              <div className="text-2xs text-text-muted mb-1.5">
                Detail: how much text rides inside each artifact
              </div>
              <div role="radiogroup" aria-label="Detail density" className="flex gap-1">
                {densities.map((d, i) => (
                  <button
                    key={d.id}
                    ref={(el) => { densityRefs.current[i] = el; }}
                    type="button"
                    role="radio"
                    aria-checked={d.id === density}
                    // Roving tabindex: only the checked radio is in the tab
                    // order; arrows move within the group (WAI-ARIA pattern).
                    tabIndex={d.id === density ? 0 : -1}
                    title={d.description}
                    onClick={() => handleDensityChange(d.id)}
                    onKeyDown={(e) => handleDensityKeyDown(e, i)}
                    className={`flex-1 px-2 py-1 rounded text-2xs font-medium border transition-colors ${
                      d.id === density
                        ? "bg-accent-blue-dim/40 text-accent-blue border-accent-blue/40"
                        : "border-border-default text-text-secondary hover:bg-surface-hover"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
