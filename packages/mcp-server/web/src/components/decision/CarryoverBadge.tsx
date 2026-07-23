import type { CarryoverState } from "./carryover";

/**
 * The carryover marker shown on a grain thread (workbench rail card + inline
 * pop-out composer, and — since #180 — the default DecisionCard/OptionCard +
 * ArtifactPanel decision-comment surfaces). Artifact-voice, second-person copy —
 * it talks TO the human about THEIR thread, not about "the user". Themed via
 * accent tokens (light + dark).
 *
 * SHARED (extracted VERBATIM from DecisionWorkbench in #180). Purely
 * presentational — it imports ONLY the `CarryoverState` TYPE (erased at build),
 * never the Zod-touching `computeCarryover`, so CommentThread can render it
 * without pulling coercion into the entry chunk (the D6 lazy-Zod split).
 */
export function CarryoverBadge({ state }: { state: CarryoverState }) {
  if (state.kind === "none") return null;
  if (state.kind === "carried") {
    return (
      <span
        data-testid="carryover-badge"
        data-carryover="carried"
        className="inline-flex items-center gap-1 text-2xs font-semibold text-accent-green bg-accent-green-dim rounded px-1.5 py-0.5 mb-1.5"
        title="Your thread followed this part across the agent's tune — the text it anchors to is unchanged, so it still applies."
      >
        <span aria-hidden="true">✓</span> CARRIED v{state.from}→v{state.to}
      </span>
    );
  }
  if (state.kind === "stale") {
    const msg = state.procon
      ? `this was on a pro/con of v${state.from}; the list may have changed — verify it still applies`
      : `the agent changed this — does your comment still apply?`;
    return (
      <span
        data-testid="carryover-badge"
        data-carryover="stale"
        className="inline-flex items-start gap-1 text-2xs font-semibold text-accent-amber bg-accent-amber-dim rounded px-1.5 py-0.5 mb-1.5"
        title={msg}
      >
        <span aria-hidden="true">⚠</span> <span>{msg}</span>
      </span>
    );
  }
  return (
    <span
      data-testid="carryover-badge"
      data-carryover="orphan"
      className="inline-flex items-center gap-1 text-2xs font-semibold text-accent-red bg-accent-red-dim rounded px-1.5 py-0.5 mb-1.5"
      title="This thread was on a part of an earlier version that's no longer in this decision — the option was removed or its id changed across the tune."
    >
      from v{state.from} · no longer in this decision
    </span>
  );
}
