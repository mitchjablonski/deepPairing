import { useEffect, useRef, type RefObject } from "react";

/**
 * Dismiss a popover when the user clicks outside it or presses Escape. For the
 * lightweight Ask/Comment popovers that aren't full modals (no focus trap), so
 * they don't linger open or stack up. `onDismiss` is held in a ref so the
 * listeners aren't re-subscribed on every render.
 */
export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onDismiss: () => void,
): void {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cb.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, active]);
}
