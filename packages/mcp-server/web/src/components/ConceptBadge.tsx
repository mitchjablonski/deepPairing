import { useEffect, useState } from "react";
import { useLedgerStore, ensureLedgerSubscriptions } from "../stores/ledger";

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
 *
 * B4 — the badge is LEDGER-AWARE. Pre-B4 it was a dead end: learn
 * "dependency inversion" on Monday and nothing acknowledged the same concept
 * on Thursday. Now, when the cross-project ledger knows the concept, the
 * badge shows the recurrence ("seen 3×") and your stance direction ("you
 * avoid this" / "matches your preference") — the positive-alignment pip the
 * UX review asked for, delivered exactly where the concept appears — and the
 * expanded panel deep-links into the YourTasteDrawer highlighted on that row
 * (the same BB6 event PreflightBreadcrumb uses).
 */

interface ConceptRecurrence {
  stance: "avoid" | "prefer" | "mixed" | null;
  count: number;
}

function useConceptRecurrence(name: string): ConceptRecurrence | null {
  const digest = useLedgerStore((s) => s.digest);
  // Idempotent: wires the shared trace listener + fires ONE initial digest
  // fetch app-wide (module-flag dedup in the store) — N mounted badges don't
  // stack requests.
  useEffect(() => {
    ensureLedgerSubscriptions();
  }, []);
  if (!digest) return null;
  const needle = name.trim().toLowerCase();
  // Defensive — the digest is network data; a partial shape must degrade to
  // "unknown concept", never crash the badge.
  const seeded = (digest.seededStances ?? []).find((s) => s.concept.trim().toLowerCase() === needle);
  const cited = (digest.topCitedStances ?? []).find((s) => s.concept.trim().toLowerCase() === needle);
  if (!seeded && !cited) return null;
  const count = Math.max(
    cited?.globalCitationCount ?? cited?.citationCount ?? 0,
    seeded?.citedTimesElsewhere ?? 0,
  );
  return { stance: seeded?.stance ?? null, count };
}

const STANCE_LABELS: Record<string, { text: string; cls: string }> = {
  avoid: { text: "you avoid this", cls: "text-accent-red" },
  prefer: { text: "matches your preference", cls: "text-accent-green" },
  mixed: { text: "mixed history", cls: "text-accent-amber" },
};

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
  const recurrence = useConceptRecurrence(name);
  const hasExplanation = Boolean(explanation && explanation.trim().length > 0);
  // B4 — a ledger-known concept is expandable even without an explanation
  // (the panel carries the deep-link into the drawer).
  const expandable = hasExplanation || recurrence !== null;
  const padding = size === "md" ? "px-2 py-1" : "px-1.5 py-0.5";
  const stanceInfo = recurrence?.stance ? STANCE_LABELS[recurrence.stance] : null;

  const openInLedger = () => {
    window.dispatchEvent(
      new CustomEvent("dp:open-your-taste", {
        detail: { initialTab: "ledger", highlightConcept: name },
      }),
    );
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (expandable) setOpen((v) => !v);
        }}
        className={`inline-flex items-center gap-1 ${padding} rounded text-2xs font-medium bg-accent-violet-dim/40 text-accent-violet border border-accent-violet/20 ${
          expandable ? "hover:bg-accent-violet-dim/60 cursor-pointer" : "cursor-default"
        } transition-colors`}
        title={expandable ? "Click to see why this concept applies" : "Concept tag"}
        aria-expanded={expandable ? open : undefined}
        aria-label={`Concept: ${name}`}
      >
        <span aria-hidden className="text-[10px] opacity-80">◆</span>
        <span className="truncate max-w-[220px]">{name}</span>
        {recurrence && recurrence.count >= 2 && (
          <span className="text-[10px] opacity-80 shrink-0" title="Times this concept appears in your cross-project ledger">
            · seen {recurrence.count}×
          </span>
        )}
        {stanceInfo && (
          <span className={`text-[10px] shrink-0 ${stanceInfo.cls}`}>· {stanceInfo.text}</span>
        )}
        {expandable && (
          <span aria-hidden className="text-[10px] opacity-60">{open ? "▾" : "▸"}</span>
        )}
      </button>
      {open && expandable && (
        <div
          className="text-2xs text-text-secondary leading-relaxed pl-2 border-l-2 border-accent-violet/30 space-y-1"
          // Inside a clickable option card — the panel must never select it.
          onClick={(e) => e.stopPropagation()}
        >
          {hasExplanation && <div>{explanation}</div>}
          {recurrence && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openInLedger();
              }}
              className="text-accent-violet hover:underline"
            >
              View in your ledger →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
