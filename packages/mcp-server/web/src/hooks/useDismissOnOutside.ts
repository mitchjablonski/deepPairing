import { useEffect, useRef, type RefObject } from "react";

/**
 * Dismiss a popover when the user clicks outside it or presses Escape. For the
 * lightweight Ask/Comment popovers that aren't full modals (no focus trap), so
 * they don't linger open or stack up. `onDismiss` is held in a ref so the
 * listeners aren't re-subscribed on every render.
 *
 * Dismisses on the outside CLICK, not the mousedown. These popovers render in
 * flow, so closing one collapses the space it held; closing on mousedown moved
 * the trigger under the pointer before mouseup, the browser saw press and
 * release on different elements, and no click fired — you couldn't go straight
 * from one comment box to the next one below it. The mousedown is still
 * recorded so a press that STARTED inside (a text selection dragged past the
 * edge) doesn't count as an outside click.
 *
 * Both listeners run in the CAPTURE phase. Many outside controls call
 * `stopPropagation()` in their onClick (e.g. OptionCard's Ask wrapper), and in
 * the bubble phase that silently kept this popover open, so two popovers stacked
 * up. Capture also runs before any React handler, so the target can't have been
 * detached yet, and the click that OPENED the popover has already passed
 * the document by the time this listener attaches.
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
    let downInside = false;
    const inside = (e: Event) => !!ref.current && ref.current.contains(e.target as Node);
    const onDown = (e: MouseEvent) => {
      downInside = inside(e);
    };
    const onClick = (e: MouseEvent) => {
      const startedInside = downInside;
      downInside = false;
      if (ref.current && !startedInside && !inside(e)) cb.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cb.current();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, active]);
}
