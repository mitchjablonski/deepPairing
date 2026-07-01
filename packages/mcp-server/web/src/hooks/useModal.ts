import { useRef, type KeyboardEvent, type RefObject } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { useOverlayPresence } from "../stores/overlay";

/**
 * The app's ONE modal-overlay contract, so the five conventions can't drift
 * per-component (the pre-consolidation state had SettingsSheet missing
 * role="dialog", HookStatus claiming aria-modal with no focus trap, and App.tsx
 * hand-maintaining a 5-boolean shortcut-suppression list beside the store).
 *
 * A modal calls `useModal` and spreads `dialogProps` onto its panel element:
 *   - useOverlayPresence(active) — suppresses the global j/k/a/r/q artifact
 *     shortcuts while open (App reads the store; no per-overlay hand-list).
 *   - useFocusTrap(ref, active) — moves focus into the panel, traps Tab, restores
 *     focus to the trigger on close.
 *   - role="dialog" + aria-modal + tabIndex=-1 + Esc→onClose via spread props.
 *
 * Outside-click stays per-overlay: it's structural (the backdrop's onClick), and
 * drawers vs centered dialogs vs the diagram lightbox place the backdrop
 * differently. `active` defaults true (most overlays are conditionally mounted);
 * pass a flag for always-mounted-but-hidden surfaces.
 */
export interface UseModalResult {
  /** Attach to the panel element (also included in `dialogProps`). */
  ref: RefObject<HTMLDivElement | null>;
  dialogProps: {
    ref: RefObject<HTMLDivElement | null>;
    role: "dialog";
    "aria-modal": true;
    tabIndex: -1;
    onKeyDown: (e: KeyboardEvent) => void;
  };
}

export function useModal(opts: { active?: boolean; onClose: () => void }): UseModalResult {
  const active = opts.active ?? true;
  const ref = useRef<HTMLDivElement>(null);
  useOverlayPresence(active);
  useFocusTrap(ref, active);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // Stop here so a nested modal's Esc doesn't also close an outer one, and
      // so the app-level Esc handlers don't double-fire.
      e.stopPropagation();
      opts.onClose();
    }
  };
  return {
    ref,
    dialogProps: { ref, role: "dialog", "aria-modal": true, tabIndex: -1, onKeyDown },
  };
}
