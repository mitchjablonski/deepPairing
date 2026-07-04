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
 * DD7 — restores focus to the previously-focused element on unmount /
 * deactivation. Pre-DD7 a keyboard user who opened a drawer via the
 * header button and pressed Esc found focus dropped to <body> and had
 * to Tab-walk to find their place. Standard a11y dialog pattern.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    // DD7 — capture the trigger element so Esc / dismiss returns focus
    // to where the user came from. Done first so even an early-return
    // path (no focusables inside) still records it.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = (): HTMLElement[] =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => !n.hasAttribute("disabled") && n.offsetParent !== null,
      );

    // Auto-focus the first focusable element if focus isn't already inside.
    const [firstNode] = getFocusable();
    if (firstNode && !el.contains(document.activeElement)) {
      firstNode.focus();
    }

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = getFocusable();
      const first = focusables[0];
      const last = focusables.at(-1);
      if (!first || !last) return;
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
    return () => {
      el.removeEventListener("keydown", handler);
      // DD7 — restore focus only if the element is still in the DOM
      // and focusable. Guards against the trigger having been
      // unmounted in the meantime.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        try { previouslyFocused.focus(); } catch {}
      }
    };
  }, [ref, active]);
}
