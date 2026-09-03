import { useMemo, useRef, useState } from "react";
// The SUBPATH, not the package root. The root index pulls Zod in with it, and
// Zod lives in the eager entry chunk — importing the linter through it would
// have parked 12KB of rules in every page load for a chip that is lazy and
// usually hidden. prose-lint.ts has no imports at all, so through the subpath
// it lands in this component's own chunk.
import { lintArtifactContent, bySeverity, type Violation } from "@deeppairing/shared/prose-lint";
import type { Artifact } from "@deeppairing/shared";
import { useDismissOnOutside } from "../hooks/useDismissOnOutside";

/**
 * "Write to your pair" — the clarity chip.
 *
 * The companion half of the STYLE block the MCP server appends to a present_*
 * result. It calls the SAME shared linter, client-side, on content the store
 * already holds: no new API route, no new stored field, nothing persisted. The
 * agent's number and the human's number therefore come from one implementation
 * and can never disagree.
 *
 * It renders nothing at all when the prose is clean, so a well-written artifact
 * carries no chrome. Clicking it expands the violations grouped by field.
 *
 * LAZY BY DESIGN — mount this through React.lazy. The import above pulls the
 * shared package's runtime index, which drags Zod in with it, and ArtifactPanel
 * is the entry chunk (see the lazy renderer block there).
 */

/**
 * THE VISIBILITY GATE. The chip used to render on any violation at all, which
 * put a "clarity 96" badge on roughly two thirds of hand-polished artifacts —
 * a permanent piece of chrome that told the reader nothing they could act on.
 * A score at or above this is prose that is fine, so the card stays clean and
 * the chip means something when it does appear.
 */
const SHOW_AT = 96;

/** Below this the chip turns amber. Below the second, red. */
const WARN_AT = 85;
const BAD_AT = 65;

function toneFor(score: number): { chip: string; dot: string; label: string } {
  if (score < BAD_AT) {
    return {
      chip: "bg-accent-red-dim/40 text-accent-red border-accent-red/20 hover:bg-accent-red-dim/60",
      dot: "text-accent-red",
      label: "dense",
    };
  }
  if (score < WARN_AT) {
    return {
      chip: "bg-accent-amber-dim/40 text-accent-amber border-accent-amber/20 hover:bg-accent-amber-dim/60",
      dot: "text-accent-amber",
      label: "a little dense",
    };
  }
  return {
    chip: "bg-surface-elevated text-text-muted border-border-default hover:bg-surface-hover",
    dot: "text-text-muted",
    label: "mostly clean",
  };
}

/** Human-facing name for each rule id, so the panel groups read as advice. */
const RULE_LABELS: Record<string, string> = {
  "sentence-length": "long sentence",
  "parenthetical-density": "parentheticals",
  semicolon: "semicolon",
  "all-caps-emphasis": "shouting",
  "slash-pack": "slash pack",
  "arrow-chain": "arrow in prose",
  "em-dash-budget": "em-dashes",
  "undefined-coinage": "undefined coinage",
  "inline-enumeration": "inline list",
  "paragraph-length": "long paragraph",
  "trailing-condition": "trailing condition",
  "vague-recommendation": "vague recommendation",
  wordiness: "wordiness",
};

export function ClarityChip({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(rootRef, open, () => setOpen(false));

  const result = useMemo(() => {
    try {
      return lintArtifactContent(artifact.type, artifact.content);
    } catch {
      // The chip is a nicety. It must never take the artifact down with it.
      return { fields: [], violations: [] as Violation[], score: 100 };
    }
  }, [artifact.type, artifact.content]);

  if (result.violations.length === 0 || result.score >= SHOW_AT) return null;

  const tone = toneFor(result.score);
  const count = result.violations.length;

  // Enter/Space inside a clickable ancestor must not activate the ancestor.
  const stopActivationKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  };

  return (
    // Anchored popover, not an inline expansion: the chip lives in the header's
    // badge row, so growing in place would shove the title around on every
    // click. Escape and an outside click both close it.
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={stopActivationKeys}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium border cursor-pointer transition-colors ${tone.chip}`}
        title={`House prose check: ${tone.label}. ${count} note${count === 1 ? "" : "s"} across ${result.fields.length} field${result.fields.length === 1 ? "" : "s"}. Click to read them.`}
        aria-expanded={open}
        aria-label={`Clarity ${result.score} of 100, ${count} prose note${count === 1 ? "" : "s"}`}
        data-testid="clarity-chip"
      >
        <span aria-hidden className={`text-[10px] opacity-80 ${tone.dot}`}>
          ◐
        </span>
        <span>clarity {result.score}</span>
        <span aria-hidden className="text-[10px] opacity-60">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-30 mt-1 w-[min(65ch,80vw)] max-h-[50vh] overflow-y-auto rounded border border-border-default bg-surface-elevated p-2 shadow-lg text-2xs text-text-secondary leading-relaxed space-y-2"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={stopActivationKeys}
          data-testid="clarity-panel"
        >
          <p className="text-text-muted">
            House prose style, advisory only — nothing was changed or blocked.
          </p>
          {result.fields.map((field) => (
            <div key={field.path} className="space-y-0.5">
              <div className="font-medium text-text-secondary">
                {field.path}
                <span className="text-text-muted font-normal"> · {field.mode}</span>
              </div>
              <ul className="space-y-0.5">
                {[...field.violations].sort(bySeverity).map((v, i) => (
                  <li key={`${v.ruleId}-${v.index}-${i}`} className="flex gap-1.5">
                    <span className="shrink-0 px-1 py-px rounded text-[9px] uppercase tracking-wide bg-surface-elevated text-text-muted">
                      {RULE_LABELS[v.ruleId] ?? v.ruleId}
                    </span>
                    <span className="min-w-0">
                      <span>{v.message}</span>
                      {v.excerpt && (
                        <span className="text-text-muted"> — “{v.excerpt}”</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
