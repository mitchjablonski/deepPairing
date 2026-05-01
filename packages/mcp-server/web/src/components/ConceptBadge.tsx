import { useState } from "react";

/**
 * Y5 — compact concept badge for DecisionCard options + CodeChangeArtifact.
 *
 * Sister to ReasoningCard's ConceptCallout (which is a big "The pattern at
 * play" block). This is the dense version that fits inside an option card
 * or a code-change header without dominating it. One-line by default;
 * click expands the explanation.
 *
 * Why repeat the concept treatment across three artifact types: the
 * pairing-thesis lever is "the human learns the pattern, not just the
 * fix" — naming it once on log_reasoning isn't enough when the choice
 * itself (an option, an edit) is where the learning lives.
 */
export function ConceptBadge({
  name,
  explanation,
  size = "sm",
}: {
  name: string;
  explanation?: string;
  /** "sm" for option cards, "md" for code-change headers. Affects padding only. */
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const hasExplanation = Boolean(explanation && explanation.trim().length > 0);
  const padding = size === "md" ? "px-2 py-1" : "px-1.5 py-0.5";

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (hasExplanation) setOpen((v) => !v);
        }}
        className={`inline-flex items-center gap-1 ${padding} rounded text-2xs font-medium bg-accent-violet-dim/40 text-accent-violet border border-accent-violet/20 ${
          hasExplanation ? "hover:bg-accent-violet-dim/60 cursor-pointer" : "cursor-default"
        } transition-colors`}
        title={hasExplanation ? "Click to see why this concept applies" : "Concept tag"}
        aria-expanded={hasExplanation ? open : undefined}
        aria-label={`Concept: ${name}`}
      >
        <span aria-hidden className="text-[10px] opacity-80">◆</span>
        <span className="truncate max-w-[220px]">{name}</span>
        {hasExplanation && (
          <span aria-hidden className="text-[10px] opacity-60">{open ? "▾" : "▸"}</span>
        )}
      </button>
      {open && hasExplanation && (
        <div className="text-2xs text-text-secondary leading-relaxed pl-2 border-l-2 border-accent-violet/30">
          {explanation}
        </div>
      )}
    </div>
  );
}
