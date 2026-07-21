import { useCallback, useEffect, useRef, useState } from "react";

/**
 * #175 — the confirm-countdown affordance, factored out so the changeset's
 * derived approve uses the SAME "Approving in 3…2…1 · press to comment · Esc to
 * hold" pattern the single-artifact footer arms (ArtifactStatusActions'
 * countdown). It never HARD-commits: arming leaves a visible window to add an
 * approval comment or cancel, then proceeds on its own.
 *
 * Semantics (mirrors ArtifactStatusActions):
 *   - `arm(seconds)` starts the countdown (un-pausing a prior hold).
 *   - it ticks once a second; reaching 0 fires `onCommit` exactly once.
 *   - `cancel()` (user Cancel, Esc, or typing) HOLDS: it clears the countdown
 *     AND latches `held` so an auto-arm caller can avoid immediately re-arming.
 *   - Escape while armed cancels (scoped to the armed window so it never
 *     swallows an overlay's Escape).
 *
 * A future consolidation could have ArtifactStatusActions adopt this hook; kept
 * separate for now to avoid destabilizing that heavily-tested footer.
 */
export interface ConfirmCountdown {
  /** Seconds remaining, or null when disarmed. */
  countdown: number | null;
  /** The seconds value the current countdown was armed with (for the progress bar). */
  countdownMax: number;
  /** True while a countdown is actively ticking (not held). */
  armed: boolean;
  /** True once cancelled — lets an auto-arm effect avoid re-firing. */
  held: boolean;
  arm: (seconds: number) => void;
  cancel: () => void;
}

export function useConfirmCountdown(onCommit: () => void): ConfirmCountdown {
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownMax, setCountdownMax] = useState(3);
  const [held, setHeld] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Keep the latest onCommit without re-subscribing the tick effect.
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const arm = useCallback((seconds: number) => {
    setHeld(false);
    setCountdownMax(seconds);
    setCountdown(seconds);
  }, []);

  const cancel = useCallback(() => {
    setCountdown(null);
    setHeld(true);
  }, []);

  // Tick + commit-at-zero (IO effect, like ArtifactStatusActions').
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      setCountdown(null);
      commitRef.current();
      return;
    }
    intervalRef.current = setInterval(() => setCountdown((c) => (c === null ? c : c - 1)), 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [countdown]);

  // Escape holds — scoped to the armed window so it can't eat overlay Escapes.
  const armed = countdown !== null;
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed, cancel]);

  return { countdown, countdownMax, armed, held, arm, cancel };
}
