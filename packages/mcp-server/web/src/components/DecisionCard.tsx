import { useState, useRef, useEffect } from "react";
// B5 — `m` + LazyMotion (App loads domAnimation) instead of the full
// `motion` component: drops ~40kB gzip of animation features nothing uses
// from the ENTRY bundle. Same animations.
import { m, AnimatePresence } from "motion/react";
import type { DecisionRequestEvent } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { SimpleMarkdown } from "./SimpleMarkdown";
import { AskTrigger } from "./CommentThread";
import { RepairDecisionModal } from "./RepairDecisionModal";
import { ConceptBadge } from "./ConceptBadge";
import { VisualBody } from "./ArtifactVisuals";

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
  initialResolved?: {
    optionId: string;
    reasoning?: string;
    resolvedAt?: string;
    confidence?: "low" | "medium" | "high";
    predictedOutcome?: string;
  };
  /** For the Re-pair modal: which session this decision was recorded in. */
  sessionId?: string;
  onResolved?: () => void;
}

const badgeColors = {
  low: "bg-accent-green-dim text-accent-green",
  medium: "bg-accent-amber-dim text-accent-amber",
  high: "bg-accent-red-dim text-accent-red",
};

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
  const [focusedIndex, setFocusedIndex] = useState(() => {
    // findIndex returns -1 (not undefined) when nothing is recommended, so the
    // old `?? 0` never fired and focusedIndex could be -1 → options[-1] throws
    // on Enter. Default to the first option when there's no recommendation.
    const i = event.options.findIndex((o) => o.recommendation);
    return i < 0 ? 0 : i;
  });
  const [reasoning, setReasoning] = useState(initialResolved?.reasoning ?? "");
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
  const [sendBackText, setSendBackText] = useState("");
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
      setPhase({ kind: "resolved", optionId });
      onResolved?.();
    } catch {
      // Roll back to idle so the user can retry. No silent stuck state.
      setPhase({ kind: "idle" });
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleSelect = async (optionId: string) => {
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
      // decision instead of activating it (the same exposure AskTrigger had). The
      // option card itself is a role="button" *div* (tag DIV), so its own
      // Enter/Space selection still flows through below.
      if (tag === "BUTTON" || tag === "A") return;

      // UX2 — within the card, j/k move the option highlight and we
      // stopPropagation so App's document-level j/k doesn't ALSO navigate
      // artifacts (which would unmount the card). AT THE BOUNDARY (already on
      // the last/first option) we let the key BUBBLE instead, so a keyboard
      // user can still escape past the decision to the next/prev artifact.
      if (e.key === "ArrowDown" || e.key === "j") {
        if (focusedIndex >= event.options.length - 1) return; // at last → bubble to App nav
        e.preventDefault();
        e.stopPropagation();
        setFocusedIndex((i) => Math.min(i + 1, event.options.length - 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        if (focusedIndex <= 0) return; // at first → bubble to App nav
        e.preventDefault();
        e.stopPropagation();
        setFocusedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (showReasoning) return; // Let the reasoning input handle Enter
        handleSelect(event.options[focusedIndex].id);
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
        handleSelect(event.options[focusedIndex]?.id ?? event.options[0]?.id);
      } else if (detail.action === "revise") {
        // mirror the footer button — the two composers are mutually exclusive
        setShowSendBack(true);
        setShowReasoning(false);
      }
    };
    window.addEventListener("dp:artifact-shortcut", onShortcut);
    return () => window.removeEventListener("dp:artifact-shortcut", onShortcut);
    // handleSelect closes over phase/stakes/predictOptIn/reasoning — keep it in
    // deps so the approve shortcut never fires with stale selection state.
  }, [artifactId, resolved, focusedIndex, event.options, handleSelect]);

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
    const chosen = event.options.find((o) => o.id === selectedId);
    const rejected = event.options.filter((o) => o.id !== selectedId);

    return (
      <>
        <m.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
          className="mx-3 my-2 p-4 bg-accent-green-dim border border-accent-green/20 rounded-lg"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-accent-green text-lg">✓</span>
            <span className="text-sm font-semibold text-accent-green">Decision Made</span>
            {sessionId && (
              <button
                onClick={() => setShowRepair(true)}
                className="ml-auto px-2 py-0.5 rounded text-2xs font-medium text-accent-violet hover:bg-accent-violet-dim/40 transition-colors"
                title="Generate a prompt to revisit this decision with fresh eyes in a new Claude Code session"
              >
                ↻ Re-pair
              </button>
            )}
          </div>
          <p className="text-sm text-text-primary">
            <span className="font-medium">{chosen?.title}</span>
            {reasoning && <span className="text-text-muted"> — {reasoning}</span>}
          </p>
          {/* C2 — the handoff gets a receipt. Comments already had one
              ("seen by agent"); the app's MOST important interaction didn't. */}
          <p className="text-2xs" aria-live="polite">
            {agentPickedUp ? (
              <span className="text-accent-green">✓ Claude picked this up — proceeding with "{chosen?.title}"</span>
            ) : (
              <span className="text-text-muted">Delivered — Claude will pick it up next time it checks in</span>
            )}
          </p>
          {(initialResolved?.predictedOutcome || initialResolved?.confidence) && (
            <div className="mt-2 pt-2 border-t border-accent-green/15">
              <div className="flex items-start gap-2">
                <span className="text-2xs font-semibold text-accent-amber shrink-0 mt-0.5">
                  Predicted:
                </span>
                <div className="flex-1 min-w-0">
                  {initialResolved.predictedOutcome && (
                    <p className="text-xs text-text-secondary">{initialResolved.predictedOutcome}</p>
                  )}
                  {initialResolved.confidence && (
                    <span className="inline-block mt-1 text-2xs text-text-muted italic">
                      ({initialResolved.confidence} confidence)
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
          {rejected.length > 0 && (
            <div className="mt-2 pt-2 border-t border-accent-green/15">
              <span className="text-xs text-text-muted">
                Rejected: {rejected.map((o) => o.title).join(", ")}
              </span>
            </div>
          )}

          {/* Read-only review of every option, so you can see what each one
              entailed (description, concept, pros/cons, effort/risk) without
              hitting Re-pair. Collapsed by default to keep the resolved card
              compact; Re-pair stays for actually re-deciding in a new session. */}
          <div className="mt-2 pt-2 border-t border-accent-green/15">
            <button
              onClick={() => setShowOptions((v) => !v)}
              aria-expanded={showOptions}
              className="text-2xs font-medium text-text-muted hover:text-text-primary transition-colors"
            >
              {showOptions ? "Hide options ▴" : "Show options ▾"}
            </button>
            {showOptions && (
              <div className="mt-2 space-y-2">
                {event.options.map((option) => {
                  const isChosen = option.id === selectedId;
                  return (
                    <div
                      key={option.id}
                      className={`p-3 rounded-lg border ${
                        isChosen
                          ? "border-accent-green/40 bg-accent-green-dim/20"
                          : "border-white/[0.06] bg-surface-elevated/60 opacity-80"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
                        <h4 className="text-sm font-semibold text-text-primary">{option.title}</h4>
                        {isChosen ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-semibold bg-accent-green text-white rounded">
                            ✓ Chosen
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 text-2xs font-medium text-text-muted bg-surface-elevated rounded">
                            Not chosen
                          </span>
                        )}
                        {option.recommendation && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-semibold bg-accent-violet text-white rounded"
                            title="Agent recommended this option"
                          >
                            ★ Recommended
                          </span>
                        )}
                      </div>
                      <SimpleMarkdown text={option.description} className="text-xs text-text-secondary mb-2 space-y-1" />
                      {option.concept?.name && (
                        <div className="mb-2">
                          <ConceptBadge name={option.concept.name} explanation={option.concept.oneLineExplanation} />
                        </div>
                      )}
                      {Array.isArray(option.pros) && option.pros.length > 0 && (
                        <div className="space-y-0.5 mb-1.5">
                          {option.pros.map((pro, i) => (
                            <div key={i} className="flex items-start gap-1.5 text-xs">
                              <span className="text-accent-green shrink-0 mt-0.5">✓</span>
                              <span className="text-text-secondary">{pro}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {Array.isArray(option.cons) && option.cons.length > 0 && (
                        <div className="space-y-0.5 mb-2">
                          {option.cons.map((con, i) => (
                            <div key={i} className="flex items-start gap-1.5 text-xs">
                              <span className="text-accent-red shrink-0 mt-0.5">✗</span>
                              <span className="text-text-secondary">{con}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-1">
                        <span className={`px-1.5 py-0.5 text-2xs rounded ${badgeColors[option.effort]}`}>
                          {option.effort}
                        </span>
                        <span className={`px-1.5 py-0.5 text-2xs rounded ${badgeColors[option.risk]}`}>
                          {option.risk} risk
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Q3: horizon-check trigger — only on high-stakes decisions. Fires a
              question-intent comment asking the agent for a failure-mode
              prediction at the chosen horizon (the agent answers it directly).
              Most useful for schema, auth, caching, pipeline, and queue
              semantics — exactly what `stakes: "high"` flags. */}
          {stakes === "high" && artifactId && (
            <div className="mt-2 pt-2 border-t border-accent-green/15">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-2xs text-text-muted italic shrink-0">
                  Ask for a horizon prediction:
                </span>
                {horizonRequested ? (
                  <span className="text-2xs text-accent-violet font-medium">
                    ✓ Asked ({horizonRequested}) — the agent will respond via a comment.
                  </span>
                ) : (
                  <>
                    {(["3mo", "1y", "2y"] as const).map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => requestHorizonCheck(h)}
                        className="px-2 py-0.5 rounded border border-accent-violet/40 text-2xs text-accent-violet hover:bg-accent-violet-dim/30 transition-colors"
                        aria-label={`Request horizon check at ${h}`}
                      >
                        {h}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </m.div>

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
        <span className="inline-block w-2 h-2 rounded-full bg-accent-violet animate-pulse" />
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
        <span className="text-2xs text-text-muted ml-auto">↑↓ navigate · Enter select</span>
      </div>
      <SimpleMarkdown text={event.context} className="text-sm text-text-primary mb-4 space-y-2" />

      {/* Options grid */}
      <div className={`grid gap-2 ${gridCols}`}>
        <AnimatePresence>
          {event.options.map((option, idx) => (
            <m.div
              key={option.id}
              layout
              role="button"
              tabIndex={submitting ? -1 : 0}
              aria-disabled={submitting}
              // U5e — expose the keyboard/hover selection to assistive tech; the
              // focus ring (idx === focusedIndex) was color-only before. No
              // aria-label here on purpose: it would become the element's entire
              // accessible name and suppress the description/pros/cons a SR user
              // needs to choose — let the descendant content form the name.
              aria-current={idx === focusedIndex}
              onClick={() => !submitting && handleSelect(option.id)}
              onKeyDown={(e) => {
                if (submitting) return;
                // B4 review — mirror the container's native-listener tag guard
                // (DV1): Enter/Space on a NESTED interactive control (concept
                // badge, ledger deep-link, AskTrigger) must activate that
                // control, not select the option. Without this, the card's
                // preventDefault also suppressed the child button's Enter→click.
                const tag = (e.target as HTMLElement | null)?.tagName;
                if (tag === "BUTTON" || tag === "A") return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleSelect(option.id);
                }
              }}
              // X11 — affordance hierarchy. Recommended option gets a
              // visible "Recommended" pill + a violet border that matches
              // the card frame, so it reads as the primary path at a glance.
              // Pre-X11 the recommendation was a faint border tint and a
              // single star — ambiguous against a focused-state blue ring.
              className={`text-left p-3 border-2 rounded-lg transition-all duration-[180ms] ease-out press-scale cursor-pointer relative ${
                submitting ? "opacity-50 cursor-not-allowed" : ""
              } ${
                idx === focusedIndex
                  ? "border-accent-blue bg-accent-blue-dim/40 ring-1 ring-accent-blue/50"
                  : option.recommendation
                    ? "border-accent-violet/50 bg-accent-violet-dim/15 hover:border-accent-violet/70 shadow-[0_0_0_1px_rgba(124,92,252,0.08)]"
                    : "border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]"
              }`}
              onMouseEnter={() => setFocusedIndex(idx)}
              // U4 — keep the visual highlight (focusedIndex) in lockstep with
              // real DOM focus. Without this, Tab moves :focus into an option
              // while the j/k-driven blue ring sat elsewhere, and the
              // container's Enter handler (which selects options[focusedIndex])
              // could fire a different option than the one the eye was on.
              onFocus={() => !submitting && setFocusedIndex(idx)}
            >
              {/* Title + badges */}
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                  <h4 className="text-sm font-semibold text-text-primary">{option.title}</h4>
                  {option.recommendation && (
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-semibold bg-accent-violet text-white rounded"
                      title="Agent recommends this option"
                    >
                      <span aria-hidden>★</span>
                      Recommended
                    </span>
                  )}
                </div>
                {artifactId && (
                  <div
                    // Stop click here so asking a question doesn't also select
                    // the option.
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="shrink-0"
                  >
                    <AskTrigger artifactId={artifactId} target={{ optionId: option.id }} />
                  </div>
                )}
              </div>

              {/* Description */}
              <SimpleMarkdown text={option.description} className="text-xs text-text-secondary mb-2 space-y-1" />

              {/* Y5 — concept badge. Names the underlying pattern so this
                  option's rejection (or approval) compounds across projects
                  via the philosophy ledger. Click to expand the explanation.
                  Z5 — concept is now properly typed on DecisionOptionSchema
                  (was a (as any) cast pre-Z5; the wire shape lacked the
                  field that Y5 had hoisted only into the stored shape). */}
              {option.concept?.name && (
                <div
                  className="mb-2 -mx-1 px-1 py-0.5 rounded cursor-default"
                  // B6 — the WHOLE badge row is a selection-dead zone (same
                  // treatment AskTrigger gets above). The badge itself already
                  // stops propagation, but a near-miss a few px around it hit
                  // the option card and CHOSE THE DECISION. Full-row wrapper
                  // means a misclick around the ledger pip does nothing.
                  // Keydown: stop ONLY activation keys — swallowing everything
                  // killed the global j/k/a/r/q shortcuts while the badge had
                  // focus (review catch).
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                  }}
                >
                  <ConceptBadge
                    name={option.concept.name}
                    explanation={option.concept.oneLineExplanation}
                    size="md"
                  />
                </div>
              )}

              {/* Pros */}
              {Array.isArray(option.pros) && option.pros.length > 0 && (
                <div className="space-y-0.5 mb-1.5">
                  {option.pros.map((pro, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs">
                      <span className="text-accent-green shrink-0 mt-0.5">✓</span>
                      <span className="text-text-secondary">{pro}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Cons */}
              {Array.isArray(option.cons) && option.cons.length > 0 && (
                <div className="space-y-0.5 mb-2">
                  {option.cons.map((con, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs">
                      <span className="text-accent-red shrink-0 mt-0.5">✗</span>
                      <span className="text-text-secondary">{con}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Effort + Risk badges */}
              <div className="flex gap-1 mt-auto">
                <span className={`px-1.5 py-0.5 text-2xs rounded ${badgeColors[option.effort]}`}>
                  {option.effort}
                </span>
                <span className={`px-1.5 py-0.5 text-2xs rounded ${badgeColors[option.risk]}`}>
                  {option.risk} risk
                </span>
              </div>
            </m.div>
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
              className="px-3 py-1 text-xs font-medium bg-accent-violet text-white rounded
                         hover:bg-accent-violet/80 disabled:opacity-50 transition-colors press-scale"
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

      {/* X11 — escape hatches grouped under one footer instead of two
          stacked bordered blocks. Pre-X11 "Send back" and "Why this choice"
          each rendered with their own border + spacing, competing with the
          option grid for visual weight. Now they share a single muted
          footer; only the active composer expands above the row. They're
          mutually exclusive in practice — opening one closes the other. */}
      <div className="mt-3 pt-3 border-t border-accent-violet/15">
        {showSendBack && !sendBackSent && (
          <div className="space-y-2 mb-2">
            <label className="block text-2xs text-text-muted">
              What should change about the options? (the agent will revise the set, not just answer)
            </label>
            <textarea
              rows={3}
              autoFocus
              value={sendBackText}
              onChange={(e) => setSendBackText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitSendBack();
                }
                if (e.key === "Escape") {
                  setShowSendBack(false);
                  setSendBackText("");
                }
              }}
              placeholder="e.g. all 4 are matchers — what about a hybrid? Or: option B should use Y instead of X…"
              className="w-full px-2.5 py-1.5 bg-surface-secondary border border-accent-amber/30 rounded text-xs text-text-primary
                         placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-amber resize-none"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={submitSendBack}
                disabled={!sendBackText.trim()}
                className="px-3 py-1 text-xs font-medium bg-accent-amber text-text-inverse rounded
                           hover:bg-accent-amber/80 disabled:opacity-50 transition-colors press-scale"
              >
                ↻ Send back for revision
              </button>
              <button
                onClick={() => { setShowSendBack(false); setSendBackText(""); }}
                className="px-2.5 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <span className="ml-auto text-2xs text-text-muted italic">⌘⏎ to send</span>
            </div>
          </div>
        )}

        {showReasoning && (
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              placeholder="Why — becomes the 'don't propose these' reason for rejected options"
              value={reasoning}
              onChange={(e) => setReasoning(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSelect(event.options[focusedIndex].id);
                }
                if (e.key === "Escape") {
                  setShowReasoning(false);
                  setReasoning("");
                }
              }}
              autoFocus
              className="flex-1 px-3 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                         placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue"
            />
            <button
              onClick={() => { setShowReasoning(false); setReasoning(""); }}
              className="text-xs text-text-muted hover:text-text-secondary"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Tertiary affordance row — both triggers live here as muted
            text links. The "decision sent back" indicator displaces them
            once revision is requested (the user already escaped). */}
        {sendBackSent ? (
          <div className="flex items-center gap-2 text-2xs text-accent-amber">
            <span aria-hidden>↻</span>
            <span>
              Revision requested — the agent will post a revised set of options.
              You can still pick from these if you change your mind.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap text-2xs text-text-muted">
            {!showReasoning && (
              <button
                onClick={() => { setShowReasoning(true); setShowSendBack(false); }}
                className="hover:text-accent-blue transition-colors"
                title="The reason you pick gets recorded as the why for every rejected option"
              >
                + Add reasoning <span className="opacity-60">(remembered across sessions)</span>
              </button>
            )}
            {/* FF9 — opt-in prediction capture toggle on high-stakes
                decisions. When ON, clicking an option enters the
                predicting phase (confidence + outcome inputs) before
                submitting; when OFF (default), the pick submits
                immediately. Surfaces only when stakes='high'. */}
            {stakes === "high" && (
              <button
                onClick={() => setPredictOptIn((v) => !v)}
                className={`transition-colors ${predictOptIn ? "text-accent-violet" : "hover:text-accent-violet"}`}
                title="Capture confidence + predicted outcome on this pick — for calibration over time"
                aria-pressed={predictOptIn}
              >
                {predictOptIn ? "✓ Predicting outcome" : "+ Capture prediction with my pick"}
              </button>
            )}
            {artifactId && !showSendBack && (
              <button
                onClick={() => { setShowSendBack(true); setShowReasoning(false); }}
                className="hover:text-accent-amber transition-colors"
                title="None of these options fit — send the decision back to the agent for a revised option set"
                aria-label="Send decision back for revised options"
              >
                ↻ None of these fit
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
