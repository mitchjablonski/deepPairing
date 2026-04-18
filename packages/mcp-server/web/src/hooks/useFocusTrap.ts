import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Constrain Tab/Shift+Tab focus cycling to elements inside `ref`. Intended
 * for modals / overlays so keyboard-only users can't escape to the page
 * behind. Auto-focuses the first focusable element on mount when `active`
 * becomes true.
 *
 * Not a full a11y dialog — doesn't restore focus on unmount or wire
 * `aria-modal`. Callers should combine it with `role="dialog"` + Esc-to-close.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const getFocusable = (): HTMLElement[] =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => !n.hasAttribute("disabled") && n.offsetParent !== null,
      );

    // Auto-focus the first focusable element if focus isn't already inside.
    const nodes = getFocusable();
    if (nodes.length > 0 && !el.contains(document.activeElement)) {
      nodes[0].focus();
    }

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = getFocusable();
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (current === first || !el.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (current === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [ref, active]);
}
