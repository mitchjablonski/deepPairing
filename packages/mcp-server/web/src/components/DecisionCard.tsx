import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { DecisionRequestEvent } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { SimpleMarkdown } from "./SimpleMarkdown";
import { AskTrigger } from "./CommentThread";

interface DecisionCardProps {
  event: DecisionRequestEvent;
  /** decisionId for the new non-blocking API */
  decisionId?: string;
  /** Artifact id — needed for AskTrigger targeting per-option questions */
  artifactId?: string;
  onResolved?: () => void;
}

const badgeColors = {
  low: "bg-accent-green-dim text-accent-green",
  medium: "bg-accent-amber-dim text-accent-amber",
  high: "bg-accent-red-dim text-accent-red",
};

export function DecisionCard({ event, decisionId, artifactId, onResolved }: DecisionCardProps) {
  const { resolveDecision } = useArtifactStore();
  const [focusedIndex, setFocusedIndex] = useState(
    event.options.findIndex((o) => o.recommendation) ?? 0,
  );
  const [reasoning, setReasoning] = useState("");
  const [showReasoning, setShowReasoning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleSelect = async (optionId: string) => {
    if (submitting || resolved) return;
    setSubmitting(true);
    setSelectedId(optionId);

    try {
      const id = decisionId ?? event.decisionId;
      await resolveDecision(id, optionId, reasoning.trim() || undefined);
      setResolved(true);
      onResolved?.();
    } catch {
      setSelectedId(null);
    } finally {
      setSubmitting(false);
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const el = containerRef.current;
    if (!el || resolved) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, event.options.length - 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (showReasoning) return; // Let the reasoning input handle Enter
        handleSelect(event.options[focusedIndex].id);
      }
    };

    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [focusedIndex, resolved, showReasoning, event.options]);

  // Resolved state
  if (resolved) {
    const chosen = event.options.find((o) => o.id === selectedId);
    const rejected = event.options.filter((o) => o.id !== selectedId);

    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
        className="mx-3 my-2 p-4 bg-accent-green-dim border border-accent-green/20 rounded-lg"
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-accent-green text-lg">✓</span>
          <span className="text-sm font-semibold text-accent-green">Decision Made</span>
        </div>
        <p className="text-sm text-text-primary">
          <span className="font-medium">{chosen?.title}</span>
          {reasoning && <span className="text-text-muted"> — {reasoning}</span>}
        </p>
        {rejected.length > 0 && (
          <div className="mt-2 pt-2 border-t border-accent-green/15">
            <span className="text-xs text-text-muted">
              Rejected: {rejected.map((o) => o.title).join(", ")}
            </span>
          </div>
        )}
      </motion.div>
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
      className="mx-3 my-3 p-4 bg-accent-red-dim/30 border border-accent-red/15 rounded-lg focus:outline-none"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-block w-2 h-2 rounded-full bg-accent-red animate-pulse" />
        <span className="text-sm font-semibold text-accent-red">Decision Needed</span>
        <span className="text-2xs text-text-muted ml-auto">↑↓ navigate · Enter select</span>
      </div>
      <SimpleMarkdown text={event.context} className="text-sm text-text-primary mb-4 space-y-2" />

      {/* Options grid */}
      <div className={`grid gap-2 ${gridCols}`}>
        <AnimatePresence>
          {event.options.map((option, idx) => (
            <motion.div
              key={option.id}
              layout
              role="button"
              tabIndex={submitting ? -1 : 0}
              aria-disabled={submitting}
              onClick={() => !submitting && handleSelect(option.id)}
              onKeyDown={(e) => {
                if (submitting) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleSelect(option.id);
                }
              }}
              className={`text-left p-3 border rounded-lg transition-all duration-[180ms] ease-out press-scale cursor-pointer ${
                submitting ? "opacity-50 cursor-not-allowed" : ""
              } ${
                idx === focusedIndex
                  ? "border-accent-blue bg-accent-blue-dim/40 ring-1 ring-accent-blue/50"
                  : option.recommendation
                    ? "border-accent-blue/30 bg-surface-elevated hover:border-accent-blue/50"
                    : "border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]"
              }`}
              onMouseEnter={() => setFocusedIndex(idx)}
            >
              {/* Title + badges */}
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <h4 className="text-sm font-semibold text-text-primary">{option.title}</h4>
                  {option.recommendation && (
                    <span className="px-1.5 py-0.5 text-2xs font-medium bg-accent-blue-dim text-accent-blue rounded">
                      ★
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

              {/* Pros */}
              {option.pros.length > 0 && (
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
              {option.cons.length > 0 && (
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
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Reasoning — nudged because it becomes the rejection reason for the
          N-1 options you didn't pick. Without it, the agent only remembers
          "don't propose these" without knowing why. */}
      <div className="mt-3 flex items-center gap-2">
        {!showReasoning ? (
          <button
            onClick={() => setShowReasoning(true)}
            className="text-xs text-accent-blue hover:underline transition-colors"
            title="The reason you pick gets recorded as the why for every rejected option"
          >
            + Why this choice? <span className="text-text-muted">(remembered across sessions)</span>
          </button>
        ) : (
          <div className="flex gap-2 flex-1">
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
      </div>
    </div>
  );
}
