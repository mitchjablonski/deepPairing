// B5 — `m` + LazyMotion (App loads domAnimation) instead of the full
// `motion` component: drops ~40kB gzip of animation features nothing uses
// from the ENTRY bundle. Same animations.
import { m } from "motion/react";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { AskTrigger } from "../CommentThread";
import { ConceptBadge } from "../ConceptBadge";
import { badgeColors, type DecisionOption } from "./types";
import { useArtifactStore } from "../../stores/artifact";
import { useChainComments } from "../../hooks/useChainComments";
import { optionCarryover } from "./carryover";
import { CarryoverBadge } from "./CarryoverBadge";

interface OptionCardProps {
  option: DecisionOption;
  index: number;
  /** True when the roving highlight (focusedIndex) sits on this option. */
  focused: boolean;
  submitting: boolean;
  /** Artifact id — needed for AskTrigger targeting per-option questions */
  artifactId?: string;
  onSelect: (optionId: string) => void;
  onFocus: (index: number) => void;
  /** D3 review — parent-owned Select button ref so keyboard nav can move DOM
      focus in lockstep with the roving highlight. */
  selectButtonRef: (el: HTMLButtonElement | null) => void;
}

export function OptionCard({ option, index, focused, submitting, artifactId, onSelect, onFocus, selectButtonRef }: OptionCardProps) {
  // #180 — the inline card is a DEFAULT decision surface: a comment you left on
  // this option carries onto the tuned version here too (useChainComments), so
  // show the SAME carryover signal the workbench does instead of leaving it
  // hidden behind Discuss. One aggregate badge per option (the loudest of its
  // threads — a STALE thread outranks a CARRIED one); `optionCarryover` reuses
  // the shared read-model. Gated on artifactId (no anchor → no comments).
  const artifacts = useArtifactStore((s) => s.artifacts);
  const chainComments = useChainComments(artifactId ?? "");
  const carryover = artifactId
    ? optionCarryover({ artifacts, comments: chainComments, currentArtifactId: artifactId, option })
    : { kind: "none" as const };
  return (
    <m.div
      layout
      // D3 — AT restructure. The card was a role="button" DIV with
      // focusable children (concept badges, AskTrigger, ledger links)
      // — the axe nested-interactive violation, and a misclick hazard
      // (one stray click on 'compare these options' CHOSE one). The
      // card is now a plain container: selection lives in the explicit
      // Select button below (a real <button>, per-option accessible
      // name) plus the container's roving j/k + Enter. Card click no
      // longer selects — misclick-safe by construction.
      // X11 — affordance hierarchy. Recommended option gets a
      // visible "Recommended" pill + a violet border that matches
      // the card frame, so it reads as the primary path at a glance.
      className={`text-left p-3 border-2 rounded-lg transition-all duration-[180ms] ease-out relative ${
        submitting ? "opacity-50" : ""
      } ${
        focused
          ? "border-accent-blue bg-accent-blue-dim/40 ring-1 ring-accent-blue/50"
          : option.recommendation
            ? "border-accent-violet/50 bg-accent-violet-dim/15 hover:border-accent-violet/70 shadow-[0_0_0_1px_rgba(124,92,252,0.08)]"
            : "border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]"
      }`}
      onMouseEnter={() => onFocus(index)}
      // U4 — keep the visual highlight (focusedIndex) in lockstep with
      // real DOM focus. Without this, Tab moves :focus into an option
      // while the j/k-driven blue ring sat elsewhere, and the
      // container's Enter handler (which selects options[focusedIndex])
      // could fire a different option than the one the eye was on.
      onFocus={() => !submitting && onFocus(index)}
    >
      {/* Title + badges */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          <h4 className="text-sm font-semibold text-text-primary">{option.title}</h4>
          {option.recommendation && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-semibold bg-accent-violet-strong text-white rounded"
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

      {/* #180 — carryover marker for THIS option's carried comment(s). Renders
          null unless a comment carried across a tune (CarryoverBadge). */}
      <CarryoverBadge state={carryover} />

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

      {/* Effort + Risk badges + the explicit select affordance (D3) */}
      <div className="flex items-center gap-1 mt-auto">
        <span className={`px-1.5 py-0.5 text-2xs rounded ${badgeColors[option.effort]}`}>
          {option.effort}
        </span>
        <span className={`px-1.5 py-0.5 text-2xs rounded ${badgeColors[option.risk]}`}>
          {option.risk} risk
        </span>
        <button
          ref={selectButtonRef}
          data-select-option
          onClick={() => !submitting && onSelect(option.id)}
          disabled={submitting}
          // Accessible name carries the option title so a SR user
          // choosing from the buttons list can tell them apart.
          aria-label={`Select ${option.title}`}
          // U4 — keep the roving highlight in lockstep with Tab focus
          // (this button is now the card's only focusable selector).
          onFocus={() => !submitting && onFocus(index)}
          className={`ml-auto min-h-6 px-2.5 py-1 text-2xs font-semibold rounded press-scale transition-colors ${
            focused
              ? "bg-accent-blue-strong text-white"
              : "bg-surface-secondary text-text-secondary hover:bg-accent-blue-strong hover:text-white"
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          Select
        </button>
      </div>
    </m.div>
  );
}
