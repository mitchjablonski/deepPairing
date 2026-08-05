import type { SuggestionState } from "@deeppairing/shared";

/**
 * #172 / H1 (#202) — the state pill for a suggested edit, shared so
 * SuggestionCard (the full negotiation card) and the ConversationRail state
 * chip render the SAME label + palette. Extracted from SuggestionCard's local
 * `statePill` so the two surfaces can never drift.
 */
export interface SuggestionPill {
  label: string;
  cls: string;
}

export function suggestionPill(s: { state: SuggestionState; appliedInVersion?: number }): SuggestionPill {
  switch (s.state) {
    case "applied":
      return {
        label: s.appliedInVersion ? `APPLIED IN v${s.appliedInVersion} ✓` : "APPLIED ✓",
        cls: "text-accent-green bg-accent-green-dim",
      };
    case "countered":
      return { label: "COUNTERED", cls: "text-accent-violet bg-accent-violet-dim" };
    case "insisted":
      return {
        label: s.appliedInVersion ? `INSISTED · APPLIED IN v${s.appliedInVersion}` : "INSISTED",
        cls: "text-accent-violet bg-accent-violet-dim",
      };
    case "pending":
    default:
      return { label: "PENDING", cls: "text-accent-amber bg-accent-amber-dim" };
  }
}
