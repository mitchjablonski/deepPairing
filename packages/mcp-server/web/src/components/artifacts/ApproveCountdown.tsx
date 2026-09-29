/**
 * #430 PR 5 (design §2.7 item 10, §5 "Unify") — THE approve countdown. The
 * single-artifact footer said "Will auto-approve in Ns..." with a Cancel button;
 * the changeset said "Approving in N… · press to comment · Esc to hold" with a
 * Hold button, for the same armed-approve window. One component, one wording,
 * one control now. Both hosts keep their own timer state (the footer's reducer,
 * the changeset's useConfirmCountdown); this renders only.
 *
 * "Esc to hold" is true in both hosts: each cancels an ARMED countdown on
 * Escape, and a held countdown stays held (no auto re-arm).
 *
 * The button says "Hold", not the footer's old "Cancel" (#455 review asked
 * us to justify it): in BOTH hosts the click is a latched hold, not an undo —
 * the footer sets `countdownPaused` so confidence auto-arm can't re-fire, the
 * changeset sets `held` so the all-look-right edge can't re-arm — and the
 * line already says "Esc to hold". One verb for one behaviour; its title
 * spells out what holding means.
 *
 * `hint` carries a host-specific affordance (#455 review): the changeset's
 * "press to comment" — its approval takes the comment box's text with it,
 * whereas the footer's typing CANCELS the countdown, so the footer passes none.
 */
export function ApproveCountdown({ countdown, countdownMax, onHold, hint }: {
  countdown: number;
  countdownMax: number;
  onHold: () => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5" data-testid="approve-countdown">
      <div className="flex items-center justify-between">
        <span className="text-2xs text-accent-green">
          Will auto-approve in {countdown}s{hint ? ` · ${hint}` : ""} · Esc to hold
        </span>
        <button
          type="button"
          onClick={onHold}
          className="text-2xs text-text-muted hover:text-text-secondary press-scale"
          data-testid="hold-approve"
          title="Hold — stop the auto-approve; it won't re-arm on its own"
        >
          Hold
        </button>
      </div>
      <div className="h-0.5 bg-surface-elevated rounded-full overflow-hidden">
        <div
          className="h-full bg-accent-green transition-all duration-1000 ease-linear"
          style={{ width: `${(countdown / countdownMax) * 100}%` }}
        />
      </div>
    </div>
  );
}
