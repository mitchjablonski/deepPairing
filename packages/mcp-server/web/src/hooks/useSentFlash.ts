import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tiny "I just sent that" affordance hook. Several inputs (CommentThread,
 * MessageInput, ReasoningCard) flash a confirmation pip for ~2 seconds
 * after a submit completes. Centralizing it here keeps the timing in one
 * place and cleans up the timer on unmount.
 */
export function useSentFlash(durationMs = 2000) {
  const [sent, setSent] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback(() => {
    setSent(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setSent(false);
      timerRef.current = null;
    }, durationMs);
  }, [durationMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { sent, flash };
}
