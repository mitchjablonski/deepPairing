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
 */
export function ApproveCountdown({ countdown, countdownMax, onHold }: {
  countdown: number;
  countdownMax: number;
  onHold: () => void;
}) {
  return (
    <div className="space-y-1.5" data-testid="approve-countdown">
      <div className="flex items-center justify-between">
        <span className="text-2xs text-accent-green">
          Will auto-approve in {countdown}s · Esc to hold
        </span>
        <button
          type="button"
          onClick={onHold}
          className="text-2xs text-text-muted hover:text-text-secondary press-scale"
          data-testid="hold-approve"
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
