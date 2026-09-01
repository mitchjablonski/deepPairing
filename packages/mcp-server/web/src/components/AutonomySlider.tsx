import { useState, useEffect, useRef } from "react";
import { apiBase, sessionHeaders, apiGet } from "../lib/api";
import { useToastStore } from "../stores/toast";
import { useCrossProjectStore } from "../stores/crossProject";

type AutonomyLevel = "supervised" | "balanced" | "autonomous";
type DetailDensity = "rich" | "terse";
type Persona = "auto" | "fluent-engineer" | "new-to-this-code" | "stakeholder";

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
  // Q2 — the blurb used to read "Agent proceeds with its recommendations; you
  // review after", which (with the matching policy string) contradicted the
  // README's "even Minimal stops at the architectural decisions". The floor is
  // real; the dial controls ceremony, not whether the human owns the forks.
  { id: "autonomous", label: "Minimal", description: "Agent proceeds on ordinary work; still stops at architectural forks" },
];

/**
 * #139 — detail density (verbosity) is ORTHOGONAL to autonomy. Autonomy governs
 * how MANY artifacts post + gating (auto-approve); this governs how much PROSE
 * rides inside each artifact. It lives inside the same popover as a small
 * Plain/Rich toggle — deliberately NOT a second slider, since two "how much"
 * sliders would blur which one controls auto-approve. X1: this reads as a
 * POSTURE, not a dial — Plain is the default and Rich is an explicit opt-in for
 * fuller prose. Plain only trims text: every artifact still posts, Evidence and
 * diagrams are always attached.
 */
const densities: { id: DetailDensity; label: string; description: string }[] = [
  { id: "terse", label: "Plain (default)",     description: "Tight prose; same artifacts, evidence & diagrams — less text" },
  { id: "rich",  label: "Rich (fuller prose)", description: "Fuller explanations around each artifact" },
];

/**
 * Explanation persona — the WHO axis, ORTHOGONAL to autonomy (how MANY
 * artifacts) and detail density (how MUCH prose). It governs the AUDIENCE the
 * agent frames prose for. This is deliberately a QUIET escape hatch, not a
 * co-equal dial: the default is "Auto" (the agent infers the audience from the
 * work — ownership/subject/risk), and a set value pins the frame for the
 * session. Rendered as a small select inside the same popover, well below the
 * autonomy levels, so it never reads as a second primary control.
 */
const personas: { id: Persona; label: string }[] = [
  { id: "auto",             label: "Auto — infer from the work" },
  { id: "fluent-engineer",  label: "Fluent engineer" },
  { id: "new-to-this-code", label: "New to this code" },
  { id: "stakeholder",      label: "Stakeholder — plain language" },
];

export function AutonomySlider() {
  const [level, setLevel] = useState<AutonomyLevel>("supervised");
  // #139 / X1 — default "terse" mirrors the store default (plain-by-default) so
  // an old preferences.json (no detailDensity field) reads as Plain.
  const [density, setDensity] = useState<DetailDensity>("terse");
  // Explanation persona (the WHO axis). Default "auto" mirrors the store default
  // (infer-from-the-work) so an old preferences.json with no `persona` field
  // reads as Auto and the escape hatch shows its quiet default.
  const [persona, setPersona] = useState<Persona>("auto");
  /**
   * Q2 — cross-project publish opt-in, made REACHABLE.
   *
   * Round 12: `globalLedgerPublish` defaults false and the ONLY thing that
   * ever set it was the interactive `init` prompt (or the `philosophy publish`
   * CLI) — neither of which the recommended marketplace install path runs. So
   * on the install we tell people to use, the cross-project half of the
   * product was unreachable, while the README, the plugin card and the About
   * text claimed it flatly. `null` = not yet known (don't render a state we
   * haven't loaded).
   */
  const publish = useCrossProjectStore((s) => s.publish);
  const publishSaving = useCrossProjectStore((s) => s.saving);
  const setPublish = useCrossProjectStore((s) => s.setPublish);
  const hydratePublish = useCrossProjectStore((s) => s.hydratePublish);
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
        if (
          state.persona === "auto" ||
          state.persona === "fluent-engineer" ||
          state.persona === "new-to-this-code" ||
          state.persona === "stakeholder"
        ) {
          setPersona(state.persona);
        }
        // Q2 — the publish opt-in rides full-state hydration. Shared through
        // the crossProject store so this popover and the first-reject card
        // (which flips the same preference) can never disagree on screen.
        if (typeof state.globalLedgerPublish === "boolean") {
          hydratePublish(state.globalLedgerPublish);
        }
      })
      .catch(() => {});
  }, [hydratePublish]);

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

  // Explanation persona (the WHO axis) — orthogonal to autonomy and does NOT
  // gate auto-approve, so a failed save is a soft rollback (toast, no
  // auto-approve safety claim). Mirrors handleDensityChange's optimistic-then-
  // reconcile shape.
  const handlePersonaChange = async (newPersona: Persona) => {
    if (newPersona === persona) return;
    const prev = persona;
    setPersona(newPersona);
    try {
      const res = await fetch(`${apiBase()}/api/preferences`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({ persona: newPersona }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setPersona((cur) => (cur === newPersona ? prev : cur));
      useToastStore.getState().push({
        kind: "error",
        title: "Explanation persona not saved",
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

            {/* Explanation persona — the WHO axis (audience the agent frames
                prose for). Deliberately QUIET: a small labelled select, not a
                second slider or a co-equal button row. Scope is PER-SESSION and
                is IN THE LABEL ("· this session"), never a bare "Audience".
                Default "Auto" lets the agent infer the audience from the work; a
                set value is an escape hatch that pins the frame for THIS session.
                The framing indicator below reflects the OVERRIDE state (set vs
                auto) + a STATIC description of the auto behavior — it never
                claims a live per-artifact inferred persona, which the server/UI
                cannot know (auto-infer is agent-side prose guidance, not a
                server computation). */}
            <div className="px-3 py-2 border-t border-border-subtle">
              <label
                htmlFor="persona-select"
                className="block text-2xs text-text-muted mb-1.5"
              >
                Audience · this session
              </label>
              <select
                id="persona-select"
                aria-label="Explanation persona"
                title="Auto-detected per artifact. Set to override — applies to this session only."
                value={persona}
                onChange={(e) => void handlePersonaChange(e.target.value as Persona)}
                className="w-full px-2 py-1 rounded text-2xs bg-surface border border-border-default text-text-secondary hover:bg-surface-hover focus:outline-none focus:border-accent-blue/40"
              >
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>

              {/* Active-framing indicator — what frame is in effect + its
                  SOURCE. Truthful by construction: for a set persona it names the
                  override; for auto it says "adapts per artifact" and lists the
                  STATIC auto rules — never a per-artifact persona it can't know. */}
              {persona === "auto" ? (
                <div className="mt-1.5">
                  <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border border-border-default text-text-muted">
                    Framing: auto · adapts per artifact
                  </span>
                  <div className="text-[10px] text-text-muted mt-1 leading-relaxed">
                    your code → engineer · someone else’s PR → new-to-this-code ·
                    docs → stakeholder
                  </div>
                </div>
              ) : (
                <div className="mt-1.5">
                  <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-accent-blue-dim/40 text-accent-blue border border-accent-blue/40">
                    Framing: {persona} · set for this session
                  </span>
                </div>
              )}
            </div>

            {/* Q2 — CROSS-PROJECT MEMORY. The permanent home for the publish
                opt-in, so it stays findable after someone answers "Not now" to
                the first-reject card. Pre-Q2 no web control existed at all and
                the only writer was the interactive `init` prompt — which the
                marketplace install path never runs, making the cross-project
                claim on the plugin card unreachable for those users.
                Rendered only once loaded: an unknown state must not be drawn
                as "off" on a project that is in fact publishing. */}
            {publish !== null && (
              <div className="px-3 py-2 border-t border-border-subtle">
                <button
                  type="button"
                  role="switch"
                  aria-checked={publish}
                  disabled={publishSaving}
                  onClick={() => void setPublish(!publish)}
                  className="w-full flex items-center justify-between gap-2 text-left disabled:opacity-60"
                >
                  <span className="text-2xs font-medium text-text-primary">
                    Cross-project memory
                  </span>
                  <span
                    className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold border transition-colors ${
                      publish
                        ? "bg-accent-blue-dim/40 text-accent-blue border-accent-blue/40"
                        : "border-border-default text-text-muted"
                    }`}
                  >
                    {publish ? "On" : "Off"}
                  </span>
                </button>
                {/* Q2 review H2/13 — same disclosure discipline as the
                    first-reject card: name the real payload (a stance is the
                    human's own wording, so a path they typed travels with it),
                    and say plainly that switching OFF stops future writes
                    rather than withdrawing past ones. */}
                <div className="text-[10px] text-text-muted mt-1 leading-relaxed">
                  {publish
                    ? "On — new stances go to ~/.deeppairing (the stance, your reason, this project’s folder name, and an internal session id), so your other projects flag the concept as an advisory nudge, never a block. Turning this off stops future writes; it doesn’t withdraw what’s already there."
                    : "Off — stances stay in this project. Turn on to write the stance, your reason, this project’s folder name, and an internal session id to ~/.deeppairing, where your other projects can read them. No code or diffs; a stance is your wording, so a file name you type into one travels with it."}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
