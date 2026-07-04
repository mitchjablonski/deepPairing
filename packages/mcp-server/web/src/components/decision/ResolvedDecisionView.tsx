import type { Dispatch, SetStateAction } from "react";
// B5 — `m` + LazyMotion (App loads domAnimation) instead of the full
// `motion` component: drops ~40kB gzip of animation features nothing uses
// from the ENTRY bundle. Same animations.
import { m } from "motion/react";
import type { DecisionRequestEvent } from "@deeppairing/shared";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { ConceptBadge } from "../ConceptBadge";
import { badgeColors, type InitialResolved } from "./types";

interface ResolvedDecisionViewProps {
  event: DecisionRequestEvent;
  /** The chosen option id (from the resolved phase). */
  selectedId: string | null;
  /** Submitted (or recorded) reasoning to display alongside the pick. */
  reasoning: string;
  /** C2 — true once the agent's check_feedback drained this resolution. */
  agentPickedUp: boolean;
  initialResolved?: InitialResolved;
  /** For the Re-pair button: which session this decision was recorded in. */
  sessionId?: string;
  /** Artifact id — gates the Q3 horizon-check trigger block. */
  artifactId?: string;
  stakes?: "low" | "medium" | "high";
  showOptions: boolean;
  setShowOptions: Dispatch<SetStateAction<boolean>>;
  /** Q3: horizon-check request state — one request per artifact view. */
  horizonRequested: "3mo" | "1y" | "2y" | null;
  onRequestHorizon: (horizon: "3mo" | "1y" | "2y") => void;
  onOpenRepair: () => void;
}

export function ResolvedDecisionView({
  event,
  selectedId,
  reasoning,
  agentPickedUp,
  initialResolved,
  sessionId,
  artifactId,
  stakes,
  showOptions,
  setShowOptions,
  horizonRequested,
  onRequestHorizon,
  onOpenRepair,
}: ResolvedDecisionViewProps) {
  const chosen = event.options.find((o) => o.id === selectedId);
  const rejected = event.options.filter((o) => o.id !== selectedId);

  return (
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
            onClick={() => onOpenRepair()}
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
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-semibold bg-accent-violet-strong text-white rounded"
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
                    onClick={() => onRequestHorizon(h)}
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
  );
}
