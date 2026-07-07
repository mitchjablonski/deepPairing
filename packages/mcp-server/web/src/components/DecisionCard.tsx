import { useState, useRef, useEffect } from "react";
import { useDraft } from "../hooks/useDraft";
// B5 — `m` + LazyMotion (App loads domAnimation) instead of the full
// `motion` component: drops ~40kB gzip of animation features nothing uses
// from the ENTRY bundle. Same animations.
import { AnimatePresence } from "motion/react";
import { type DecisionRequestEvent, type Artifact, coerceDecisionContent } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { SimpleMarkdown } from "./SimpleMarkdown";
import { RepairDecisionModal } from "./RepairDecisionModal";
import { VisualBody } from "./ArtifactVisuals";
import { PredictionsBreadcrumb } from "./PredictionsBreadcrumb";
import { useReplayStore } from "../stores/replay";
import { OptionCard } from "./decision/OptionCard";
import { ResolvedDecisionView } from "./decision/ResolvedDecisionView";
import { DecisionFooter } from "./decision/DecisionFooter";
import type { InitialResolved } from "./decision/types";

interface DecisionCardProps {
  event: DecisionRequestEvent;
  /** decisionId for the new non-blocking API */
  decisionId?: string;
  /** Artifact id — needed for AskTrigger targeting per-option questions */
  artifactId?: string;
  /**
   * Consequentiality — "high" triggers prediction + confidence capture
   * after the human picks. Default: no prediction prompt.
   */
  stakes?: "low" | "medium" | "high";
  /** If set (e.g. in replay mode for past decisions), start in the resolved state. */
  initialResolved?: InitialResolved;
  /** For the Re-pair modal: which session this decision was recorded in. */
  sessionId?: string;
  onResolved?: () => void;
}

/**
 * X5 — DecisionCard state machine.
 *
 * Pre-X5 the component used 5+ independent flags (`submitting`, `resolved`,
 * `selectedId`, `pendingOptionId`, `sendBackSent`) with implicit
 * mutual-exclusion contracts. A network error during selection could
 * leave the component in inconsistent state; a rapid double-click during
 * an in-flight POST could fire the request twice because the React
 * `submitting` flag wasn't visible synchronously.
 *
 * Now a single discriminated union enforces the lifecycle. Aux text
 * inputs (`reasoning`, `sendBackText`, `predictedOutcome`, `confidence`)
 * are independent — they're inputs to the phase transitions, not phase
 * state. Same for orthogonal UI toggles (`showReasoning`, `showSendBack`,
 * `showRepair`, `horizonRequested`, `focusedIndex`).
 *
 * Race-guard: a useRef mirrors the submission state synchronously so the
 * second tap of a rapid double-click short-circuits BEFORE setPhase
 * flushes. AbortController scopes the in-flight POST to the component
 * lifecycle (unmount cancels).
 */
type DecisionPhase =
  | { kind: "idle" }
  | { kind: "predicting"; optionId: string }
  | { kind: "submitting" }
  | { kind: "resolved"; optionId: string }
  | { kind: "sentBack" };

export function DecisionCard({ event, decisionId, artifactId, stakes, initialResolved, sessionId, onResolved }: DecisionCardProps) {
  const resolveDecision = useArtifactStore((s) => s.resolveDecision);
  const submitComment = useArtifactStore((s) => s.submitComment);
  // C2 — consumption receipt: true once the agent's check_feedback drained
  // this resolution (live decisions_acknowledged event, or the persisted
  // acknowledged flag on hydration).
  const effectiveDecisionId = decisionId ?? event.decisionId;
  const agentPickedUp = useArtifactStore((s) =>
    Boolean(effectiveDecisionId && s.acknowledgedDecisions[effectiveDecisionId]),
  );
  // D3 review — per-option Select button refs so keyboard nav can move DOM
  // focus in lockstep with the roving highlight.
  const selectBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(() => {
    // findIndex returns -1 (not undefined) when nothing is recommended, so the
    // old `?? 0` never fired and focusedIndex could be -1 → options[-1] throws
    // on Enter. Default to the first option when there's no recommendation.
    const i = event.options.findIndex((o) => o.recommendation);
    return i < 0 ? 0 : i;
  });
  // D9 (H5 + review) — the draft survives reloads while COMPOSING; on resolve
  // it's stashed as submittedReasoning and the draft is CLEARED — a lingering
  // draft otherwise shadowed the recorded reasoning in the resolved/replay
  // views (you'd see text that was never submitted, e.g. after the decision
  // resolved from the terminal instead).
  const [reasoningDraft, setReasoningDraft] = useDraft(`dec-reason:${decisionId}`);
  const [submittedReasoning, setSubmittedReasoning] = useState<string | null>(null);
  const reasoning = submittedReasoning ?? (reasoningDraft || (initialResolved?.reasoning ?? ""));
  const setReasoning = setReasoningDraft;
  const [showReasoning, setShowReasoning] = useState(false);
  const [phase, setPhase] = useState<DecisionPhase>(
    initialResolved
      ? { kind: "resolved", optionId: initialResolved.optionId }
      : { kind: "idle" },
  );
  const inFlightRef = useRef(false);  // sync race-guard
  const [showRepair, setShowRepair] = useState(false);
  // Resolved-card disclosure: review each option's full detail (description,
  // concept, pros/cons) in place, without the heavyweight Re-pair flow.
  const [showOptions, setShowOptions] = useState(false);
  // DV1 — decision-level "Compare diagrams" bar below the option grid (kept out
  // of the cards to avoid misclick-selects). Shown by DEFAULT — when the agent
  // drew diagrams they're usually the whole point of the comparison; the bar
  // stays as a collapse toggle for anyone who wants the grid alone.
  const [showDiagrams, setShowDiagrams] = useState(true);
  /** Q3: horizon-check request state — one request per artifact view. */
  const [horizonRequested, setHorizonRequested] = useState<"3mo" | "1y" | "2y" | null>(null);
  const [predictedOutcome, setPredictedOutcome] = useState(initialResolved?.predictedOutcome ?? "");
  const [confidence, setConfidence] = useState<"low" | "medium" | "high" | "">(initialResolved?.confidence ?? "");
  /**
   * Send-back composer visibility (orthogonal to phase). After submit,
   * phase moves to "sentBack" terminal; this toggle just controls
   * whether the inline composer is visible while in idle.
   */
  const [showSendBack, setShowSendBack] = useState(false);
  const [sendBackText, setSendBackText] = useDraft(`dec-sendback:${decisionId}`);
  // FF9 — opt-in for the prediction-capture phase on high-stakes
  // decisions. Pre-FF9 every high-stakes pick was forced through the
  // predicting modal, which the PMF council called the loudest
  // remaining friction post-EE ("the prediction step now shouts
  // because everything else has gone quiet"). Memory entry
  // `feedback_optional_features.md` codifies the principle: opinionated
  // agent behaviors should be opt-in, not always-on. Default off; user
  // toggles "+ Capture prediction with my pick" before clicking an
  // option to enter the predicting flow.
  const [predictOptIn, setPredictOptIn] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Derived flags — keep the read sites readable without sprinkling
  // discriminant checks everywhere.
  const submitting = phase.kind === "submitting";
  const resolved = phase.kind === "resolved";
  const selectedId = phase.kind === "resolved" ? phase.optionId : null;
  const pendingOptionId = phase.kind === "predicting" ? phase.optionId : null;
  const sendBackSent = phase.kind === "sentBack";

  const submitSelection = async (
    optionId: string,
    prediction?: { confidence?: "low" | "medium" | "high"; predictedOutcome?: string },
  ) => {
    // Sync race-guard: a rapid double-click would otherwise see phase=idle
    // on both calls (React state batches), and both would issue the POST.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase({ kind: "submitting" });
    try {
      const id = decisionId ?? event.decisionId;
      await resolveDecision(id, optionId, reasoning.trim() || undefined, prediction);
      // Stash what was ACTUALLY submitted (trimmed — matches the record),
      // then clear the draft so it can't shadow future resolved views.
      setSubmittedReasoning(reasoning.trim());
      setReasoningDraft("");
      setPhase({ kind: "resolved", optionId });
      onResolved?.();
    } catch {
      // Roll back to idle so the user can retry. No silent stuck state.
      setPhase({ kind: "idle" });
    } finally {
      inFlightRef.current = false;
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate: handleSelect must be FRESH in the keyboard effect (field-bug precedent — stale selection state); the re-subscribe per render is the accepted cost
  const handleSelect = async (optionId: string) => {
    // F8 review — ANY select disarms the pending keyboard-commit: without
    // this, a manual click whose POST failed (phase rolls back to idle) left
    // the armed timer alive to commit the ABANDONED option. Idempotent on
    // the expiry path (which already cleared it).
    setArmedSelect(null);
    // F12 — no resolving decisions against a replayed frame (the write
    // would land in the historical session's store via owner routing).
    if (useReplayStore.getState().active) return;
    if (phase.kind !== "idle") return;
    // FF9 — gate on stakes==='high' AND user opted in to prediction
    // capture for THIS decision. Pre-FF9 the predicting phase fired
    // unconditionally on high-stakes; users habituated to mashing
    // through the modal and the calibration data quality dropped.
    if (stakes === "high" && predictOptIn) {
      setPhase({ kind: "predicting", optionId });
      return;
    }
    await submitSelection(optionId);
  };

  const confirmWithPrediction = async () => {
    if (phase.kind !== "predicting") return;
    const optionId = phase.optionId;
    const prediction = {
      confidence: (confidence || undefined) as "low" | "medium" | "high" | undefined,
      predictedOutcome: predictedOutcome.trim() || undefined,
    };
    await submitSelection(optionId, prediction);
  };

  const skipPrediction = async () => {
    if (phase.kind !== "predicting") return;
    await submitSelection(phase.optionId);
  };

  // Keyboard navigation
  useEffect(() => {
    const el = containerRef.current;
    if (!el || resolved) return;

    const handler = (e: KeyboardEvent) => {
      // Field bug: typing 'k' or 'j' inside an embedded textarea/input
      // (the "Send back with comment" composer, the "Why this choice?"
      // input) was getting eaten by the option-navigation shortcuts
      // because keystrokes bubble up to the container element. Skip the
      // navigation handler entirely when focus is on an editable.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable === true
      ) return;
      // DV1 — bail when focus is on a NESTED interactive control (the
      // "Compare diagrams" bar, the AskTrigger button, …). This is a NATIVE
      // keydown listener, so it fires during native bubbling BEFORE React's
      // synthetic dispatch — a child's React onKeyDown stopPropagation can't
      // cancel it. Without this, Enter on a nested button resolved the focused
      // decision instead of activating it (the same exposure AskTrigger had).
      // D3 review — the SELECT buttons are the exception for NAV keys only:
      // post-D3 every Tab stop in the grid is a BUTTON, so a blanket bail
      // handed j/k to App's global handler, which navigated AWAY from the
      // decision mid-choice. Enter/Space still return here (native activation
      // fires ONE click). Scoped to data-select-option so AskTrigger /
      // ConceptBadge keep their B6 behavior (global j/k untouched there).
      const isSelectBtn = target?.hasAttribute?.("data-select-option") === true;
      const isNavKey = e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp";
      if ((tag === "BUTTON" || tag === "A") && !(isSelectBtn && isNavKey)) return;

      // UX2 — within the card, j/k move the option highlight and we
      // stopPropagation so App's document-level j/k doesn't ALSO navigate
      // artifacts (which would unmount the card). AT THE BOUNDARY (already on
      // the last/first option) we let the key BUBBLE instead, so a keyboard
      // user can still escape past the decision to the next/prev artifact.
      if (e.key === "ArrowDown" || e.key === "j") {
        if (focusedIndex >= event.options.length - 1) return; // at last → bubble to App nav
        e.preventDefault();
        e.stopPropagation();
        const next = Math.min(focusedIndex + 1, event.options.length - 1);
        setFocusedIndex(next);
        // D3 review — when nav happens FROM a Select button, DOM focus must
        // follow the highlight: otherwise Enter fires the STALE button's
        // native click and selects a different option than the highlighted
        // one (wrong-selection hazard).
        if (isSelectBtn) selectBtnRefs.current[next]?.focus();
      } else if (e.key === "ArrowUp" || e.key === "k") {
        if (focusedIndex <= 0) return; // at first → bubble to App nav
        e.preventDefault();
        e.stopPropagation();
        const next = Math.max(focusedIndex - 1, 0);
        setFocusedIndex(next);
        if (isSelectBtn) selectBtnRefs.current[next]?.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (showReasoning) return; // Let the reasoning input handle Enter
        const focusedOption = event.options[focusedIndex];
        if (focusedOption) handleSelect(focusedOption.id);
      }
    };

    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
    // handleSelect closes over phase/stakes/predictOptIn/reasoning — it MUST be
    // in the deps or the Enter branch runs a stale closure. Field bug: on a
    // high-stakes decision, toggling "Capture prediction with my pick" and then
    // selecting via Enter (not click) resolved WITHOUT the prediction-capture
    // phase, because the stale handler still saw predictOptIn=false. (The sibling
    // shortcut effect below already lists handleSelect for the same reason.)
  }, [focusedIndex, resolved, showReasoning, event.options, handleSelect]);

  // UX2 — auto-focus the card when a draft decision is shown, so its keyboard
  // nav (↑↓/Enter, advertised in the footer) is live without a Tab/click first.
  useEffect(() => {
    // preventScroll — the breadcrumb + artifact header render above the card;
    // a scrolling focus would jump the view past them on mount.
    if (!resolved) containerRef.current?.focus({ preventScroll: true });
  }, [resolved]);

  // F8 (M4) — keyboard-armed select confirm. null = disarmed.
  const [armedSelect, setArmedSelect] = useState<{ optionId: string; left: number } | null>(null);
  // Latest-ref (the F10/G5 idiom): handleSelect is an inline arrow with new
  // identity every render — keying the tick on it reset the pending timeout
  // on ANY re-render (hover, composer keystrokes, WS traffic), stalling the
  // bar at "3s" indefinitely (review-caught).
  const handleSelectRef = useRef<(optionId: string) => void>(() => {});
  handleSelectRef.current = handleSelect;
  useEffect(() => {
    if (!armedSelect) return;
    if (armedSelect.left <= 0) {
      const { optionId } = armedSelect;
      setArmedSelect(null);
      handleSelectRef.current(optionId);
      return;
    }
    const t = setTimeout(
      () => setArmedSelect((a) => (a ? { ...a, left: a.left - 1 } : a)),
      1000,
    );
    return () => clearTimeout(t);
  }, [armedSelect]);
  // F8 review — focus-move disarms: expiry committing the option captured at
  // arm time while the ring shows another is the D3/U4 wrong-selection
  // hazard. `a` again re-arms at the new focus.
  useEffect(() => {
    setArmedSelect(null);
    // focusedIndex only — arming itself must not immediately disarm.
    // (setState is identity-stable, so the deps are complete — G8's
    // exhaustive-deps agrees.)
  }, [focusedIndex]);
  useEffect(() => {
    if (!armedSelect) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setArmedSelect(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armedSelect]);

  // UX6 — the global a/r shortcuts (App dispatches dp:artifact-shortcut) did
  // nothing on a decision: only ArtifactStatusActions listened, and a decision
  // renders DecisionCard. Map approve → select the focused option, revise →
  // open the send-back composer.
  useEffect(() => {
    if (!artifactId || resolved) return;
    const onShortcut = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as { artifactId?: string; action?: string } | undefined;
      if (!detail || detail.artifactId !== artifactId) return;
      if (detail.action === "approve") {
        // F8 (M4) — decisions are the highest-stakes artifact and got the
        // LEAST confirmation: one `a` keystroke committed the resolution
        // irreversibly (feeding the ledger + calibration data) while
        // App.tsx's contract and the ? help both promise a 3s confirm.
        // Arm the same countdown the footer uses; Escape/Cancel bails.
        const optionId = event.options[focusedIndex]?.id ?? event.options[0]?.id;
        if (optionId) setArmedSelect({ optionId, left: 3 });
      } else if (detail.action === "revise") {
        // mirror the footer button — the two composers are mutually exclusive
        setShowSendBack(true);
        setShowReasoning(false);
      }
    };
    window.addEventListener("dp:artifact-shortcut", onShortcut);
    return () => window.removeEventListener("dp:artifact-shortcut", onShortcut);
    // (The approve branch only ARMS now — no handleSelect in deps; the tick
    // effect reads it through the latest-ref.)
  }, [artifactId, resolved, focusedIndex, event.options]);

  // Send-back-with-comment: posts a tagged question comment that the
  // server's firstCallHint promotes to "REVISION REQUEST" priority. Agent
  // is told (in the embedded protocol) to call revise_artifact mode=
  // "supersede" rather than just answer_question. Decision artifact stays
  // pending until the agent supersedes it (or the user picks an option
  // anyway).
  //
  // X5 race-guard: same inFlightRef pattern as submitSelection. A rapid
  // double-click on the Send Back button used to fire the comment twice
  // because React state didn't flush before the second tap. The ref
  // short-circuits synchronously.
  const submitSendBack = async () => {
    const text = sendBackText.trim();
    if (!artifactId || !text || phase.kind !== "idle" || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await submitComment(
        artifactId,
        text,
        { sectionId: "decision_revision_requested" } as any,
        { intent: "question" },
      );
      setPhase({ kind: "sentBack" });
      setShowSendBack(false);
      setSendBackText("");
    } catch {
      // UX7d — store surfaced the error toast; keep the composer open + text for
      // retry (don't advance to sentBack) instead of an unhandled rejection.
    } finally {
      inFlightRef.current = false;
    }
  };

  // Q3: file a question-intent comment asking the agent for a horizon
  // prediction. The comment carries intent:"question" + sectionId
  // "horizon_check:request" so check_feedback surfaces it prominently and the
  // agent answers it directly (via answer_question). NOTE: this used to ask the
  // agent to call a `request_horizon_check` tool — removed in III12; the live
  // workflow is a plain question the agent answers. Local state prevents
  // double-firing from a trigger-happy click.
  const requestHorizonCheck = async (horizon: "3mo" | "1y" | "2y") => {
    if (!artifactId || horizonRequested) return;
    // Optimistic for a snappy "✓ Asked", but roll back on a failed POST — else
    // the button is permanently stuck showing success with no way to retry.
    setHorizonRequested(horizon);
    try {
      await submitComment(
        artifactId,
        `Looking ${horizon} out: what's the most likely way this decision causes pain, and what would you watch for? Answer here so it's captured for later.`,
        { sectionId: `horizon_check:request:${horizon}` } as any,
        { intent: "question" },
      );
    } catch {
      setHorizonRequested(null);
    }
  };

  // Resolved state
  if (resolved) {
    return (
      <>
        <ResolvedDecisionView
          event={event}
          selectedId={selectedId}
          reasoning={reasoning}
          agentPickedUp={agentPickedUp}
          initialResolved={initialResolved}
          sessionId={sessionId}
          artifactId={artifactId}
          stakes={stakes}
          showOptions={showOptions}
          setShowOptions={setShowOptions}
          horizonRequested={horizonRequested}
          onRequestHorizon={requestHorizonCheck}
          onOpenRepair={() => setShowRepair(true)}
        />

        {showRepair && sessionId && (
          <RepairDecisionModal
            sessionId={sessionId}
            decisionContext={event.context}
            options={event.options}
            chosenOptionId={selectedId ?? ""}
            chosenReasoning={reasoning}
            resolvedAt={initialResolved?.resolvedAt}
            decisionId={decisionId}
            onClose={() => setShowRepair(false)}
          />
        )}
      </>
    );
  }

  // Grid layout: 2 options → 2 cols, 3+ → 3 cols (max 4). Below the narrow
  // breakpoint (900px) everything stacks to a single column so split-screen
  // with Claude Code stays usable.
  const gridCols =
    event.options.length === 2
      ? "grid-cols-1 min-[900px]:grid-cols-2"
      : event.options.length >= 3
        ? "grid-cols-1 min-[900px]:grid-cols-3"
        : "";

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="mx-3 my-3 p-4 bg-accent-violet-dim/25 border border-accent-violet/20 rounded-lg focus:outline-none"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-block w-2 h-2 rounded-full bg-accent-violet-strong animate-pulse" />
        <span className="text-sm font-semibold text-accent-violet">Let's think this through</span>
        {stakes && stakes !== "low" && (
          <span
            className={`text-2xs font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ${
              stakes === "high"
                ? "bg-accent-red-dim text-accent-red"
                : "bg-accent-amber-dim text-accent-amber"
            }`}
            title={stakes === "high" ? "High stakes — the agent flagged this as consequential" : "Medium stakes"}
          >
            {stakes} stakes
          </span>
        )}
        <span className="text-2xs text-text-muted ml-auto">↑↓ navigate · Enter selects highlighted</span>
      </div>
      <SimpleMarkdown text={event.context} className="text-sm text-text-primary mb-4 space-y-2" />

      {/* F8 (M4) — keyboard-select confirm bar (mirrors the footer's). */}
      {armedSelect && (
        <div className="mb-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-2xs text-accent-green">
              Will select “{event.options.find((o) => o.id === armedSelect.optionId)?.title ?? armedSelect.optionId}” in {armedSelect.left}s… (Esc to cancel)
            </span>
            <button
              onClick={() => setArmedSelect(null)}
              className="text-2xs text-text-muted hover:text-text-secondary press-scale"
            >
              Cancel
            </button>
          </div>
          <div className="h-0.5 bg-surface-elevated rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-green transition-all duration-1000 ease-linear"
              style={{ width: `${(armedSelect.left / 3) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Options grid */}
      <div className={`grid gap-2 ${gridCols}`}>
        <AnimatePresence>
          {event.options.map((option, idx) => (
            <OptionCard
              key={option.id}
              option={option}
              index={idx}
              focused={idx === focusedIndex}
              submitting={submitting}
              artifactId={artifactId}
              onSelect={handleSelect}
              onFocus={setFocusedIndex}
              selectButtonRef={(el) => { selectBtnRefs.current[idx] = el; }}
            />
          ))}
        </AnimatePresence>
      </div>

      {/* DV1 — diagrams live in a SEPARATE full-width bar BELOW the option grid,
          not inside the cards: an in-card toggle is a big misclick target that
          would resolve the decision. This bar is outside every selectable card,
          so it can be full-width + prominent with zero misclick risk. Expanding
          shows each option's diagram(s) in a column that lines up under the
          option above (read-only VisualBody). */}
      {event.options.some((o) => Array.isArray(o.visuals) && o.visuals.length > 0) && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowDiagrams((v) => !v)}
            aria-expanded={showDiagrams}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-semibold border border-accent-blue/40 bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 hover:border-accent-blue/60 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" className="shrink-0">
              <rect x="1.5" y="6" width="5" height="4" rx="1" />
              <rect x="9.5" y="1.5" width="5" height="4" rx="1" />
              <rect x="9.5" y="10.5" width="5" height="4" rx="1" />
              <path d="M6.5 8H8M8 8V3.5H9.5M8 8V12.5H9.5" />
            </svg>
            {showDiagrams ? "Hide diagrams" : "Compare diagrams"}
            <span aria-hidden="true">{showDiagrams ? "▴" : "▾"}</span>
          </button>
          {showDiagrams && (
            <div className={`mt-2 grid gap-2 ${gridCols}`}>
              {event.options.map((option) => (
                <div key={option.id} className="space-y-2 min-w-0">
                  <div className="text-2xs font-semibold text-text-muted truncate">{option.title}</div>
                  {Array.isArray(option.visuals) && option.visuals.length > 0 ? (
                    option.visuals.map((v) => (
                      <div key={v.id} className="bg-surface-secondary rounded-lg border border-white/[0.06] p-2 space-y-1">
                        {v.title && <div className="text-2xs text-text-muted">{v.title}</div>}
                        {/* artifactId optional on DecisionCard; VisualBody only
                            uses it for comment anchoring, skipped under readOnly. */}
                        <VisualBody artifactId={artifactId ?? ""} visual={v} readOnly />
                        {v.caption && (
                          <div className="text-2xs text-text-secondary leading-relaxed">{v.caption}</div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="text-2xs text-text-muted italic px-1">No diagram for this option.</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Prediction capture — only on high-stakes decisions, only after the
          user has tentatively picked. Raw material for calibration tracking. */}
      {pendingOptionId && (
        <div className="mt-3 p-3 bg-accent-amber-dim/25 border border-accent-amber/30 rounded-lg space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-accent-amber">
              Before you commit — quick prediction
            </span>
            <span className="text-2xs text-text-muted italic">(skippable; agent flagged this high-stakes)</span>
          </div>

          <div>
            <label className="text-2xs text-text-muted block mb-1">
              What do you expect to happen as a result?
            </label>
            <textarea
              rows={2}
              autoFocus
              value={predictedOutcome}
              onChange={(e) => setPredictedOutcome(e.target.value)}
              placeholder="e.g. cache hit rate hits 85% within 2 weeks; no new p99 regressions…"
              className="w-full px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                         placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-amber resize-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-2xs text-text-muted">Confidence:</span>
            {(["low", "medium", "high"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setConfidence(c)}
                className={`px-2 py-0.5 rounded text-2xs font-medium ${
                  confidence === c
                    ? "bg-accent-amber text-white"
                    : "bg-surface-elevated text-text-muted hover:text-text-primary"
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={confirmWithPrediction}
              disabled={submitting}
              className="px-3 py-1 text-xs font-medium bg-accent-violet-strong text-white rounded
                         hover:bg-accent-violet-strong-hover disabled:opacity-50 transition-colors press-scale"
            >
              Commit with prediction
            </button>
            <button
              onClick={skipPrediction}
              disabled={submitting}
              className="px-2.5 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              Skip, just commit
            </button>
            <button
              onClick={() => setPhase({ kind: "idle" })}
              disabled={submitting}
              className="ml-auto text-2xs text-text-muted hover:text-text-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* X11 — escape-hatch footer (send-back + reasoning composers, FF9
          prediction opt-in toggle, tertiary affordance row). */}
      <DecisionFooter
        options={event.options}
        focusedIndex={focusedIndex}
        artifactId={artifactId}
        stakes={stakes}
        showSendBack={showSendBack}
        setShowSendBack={setShowSendBack}
        sendBackText={sendBackText}
        setSendBackText={setSendBackText}
        submitSendBack={submitSendBack}
        sendBackSent={sendBackSent}
        showReasoning={showReasoning}
        setShowReasoning={setShowReasoning}
        reasoning={reasoning}
        setReasoning={setReasoning}
        onSelect={handleSelect}
        predictOptIn={predictOptIn}
        setPredictOptIn={setPredictOptIn}
      />
    </div>
  );
}

/**
 * D6 (P2) — the decision-artifact wrapper, moved here from ArtifactPanel so
 * the coercion boundary (and with it the Zod runtime) lives in THIS lazy
 * chunk instead of the entry. Behavior is verbatim from the old inline IIFE.
 */
export function DecisionArtifactView({ artifact }: { artifact: Artifact }) {
  // Coercion boundary: options always an array, context/decisionId always
  // strings. (The empty-options bail is AFTER the hooks below — rules-of-hooks.)
  const dc = coerceDecisionContent(artifact.content);
  // decisionId defaults to "" — fall back to the artifact id, not "".
  const effectiveDecisionId = dc.decisionId || artifact.id;

  // Bug3 — a resolved decision must show its chosen option after a COLD reload.
  // On a normal (non-replay) load the resolved record lives in the artifact
  // store (seeded from data.state.decisions on hydrate); in replay it lives in
  // the replay store. Subscribe to both so a cross-tab resolve reflects live.
  const replayActive = useReplayStore((s) => s.active);
  const replayDecisions = useReplayStore((s) => s.decisions);
  const liveResolved = useArtifactStore((s) => s.resolvedDecisions[effectiveDecisionId]);

  // An options-less decision has nothing to render, so bail (after the hooks).
  if (dc.options.length === 0) return null;

  let initialResolved: InitialResolved | undefined;
  if (replayActive) {
    // When viewing a past resolved decision via replay, pull the record so
    // DecisionCard can open in the resolved state with the Re-pair button.
    const record = replayDecisions.find(
      (d) => d.decisionId === effectiveDecisionId || d.artifactId === artifact.id,
    );
    initialResolved = record?.response
      ? {
          optionId: record.response.optionId,
          reasoning: record.response.reasoning,
          resolvedAt: record.resolvedAt,
          confidence: (record.response as any).confidence,
          predictedOutcome: (record.response as any).predictedOutcome,
        }
      : undefined;
  } else if (liveResolved) {
    initialResolved = {
      optionId: liveResolved.optionId,
      reasoning: liveResolved.reasoning,
      resolvedAt: liveResolved.resolvedAt,
      confidence: liveResolved.confidence,
      predictedOutcome: liveResolved.predictedOutcome,
    };
  }

  return (
    <>
      {/* N3.3: surface prior predictions on similar decisions so the user
          can calibrate before choosing. Fires on EVERY decision — the
          breadcrumb self-hides when nothing matches. */}
      <PredictionsBreadcrumb
        concept={`${artifact.title} ${dc.context ?? ""}`}
        excludeArtifactId={artifact.id}
      />
      <DecisionCard
        event={{
          type: "decision_request",
          decisionId: effectiveDecisionId,
          context: dc.context,
          options: dc.options,
        }}
        decisionId={effectiveDecisionId}
        artifactId={artifact.id}
        sessionId={artifact.sessionId}
        stakes={dc.stakes}
        initialResolved={initialResolved}
      />
    </>
  );
}
