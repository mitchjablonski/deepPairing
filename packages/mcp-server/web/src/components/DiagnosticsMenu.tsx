import { useEffect, useId, useRef, useState } from "react";
import { useOverlayPresence } from "../stores/overlay";
import { usePreflightBlockStore } from "../stores/preflightBlocks";
import { useHookStatusStore } from "../stores/hookStatus";
import { AutonomySlider } from "./AutonomySlider";
import { PreflightBlockLog } from "./PreflightBlockLog";
import { HookStatus } from "./HookStatus";
import { CompoundingBadge } from "./CompoundingBadge";

/**
 * #189 (header demotion) — the overflow ("⋯") menu that pulls the low-frequency
 * diagnostic chrome OUT of the always-visible header: the autonomy dial, the
 * pre-flight gate log, the hook-fire log, and the compounding-stats Ledger pill.
 *
 * NONE of it is deleted or made unreachable — each control lives here in full,
 * with its own popover, and its keyboard shortcut (if any) is untouched. The
 * point is only that a first-time human meets Conversation / Decisions / Search
 * / Ledger / settings / help first, not a wall of framework instrumentation.
 *
 * A live PERSISTENT signal (a gate block fired this session, or the latest hook
 * fire was a nag) is surfaced as a small amber dot on the "⋯" trigger even while
 * the menu is closed — so demoting the gate/hook chips never re-buries the
 * firing #169/X7 deliberately kept visible past their toasts. Opening the menu
 * shows the full chips.
 *
 * Disclosure semantics (N1): a plain trigger with aria-expanded + aria-controls
 * revealing a labelled region — not a role="dialog" that would promise focus
 * management this non-modal popover doesn't provide.
 */
export function DiagnosticsMenu({ onOpenLedger }: { onOpenLedger: () => void }) {
  const [open, setOpen] = useState(false);
  useOverlayPresence(open); // suppress artifact shortcuts while the menu is open
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  // The persistent attention signal (Fix 1): a gate block recorded this session,
  // or the most-recent hook fire was a nag (exitCode 2) — the same "latest fire
  // is a nag" rule HookStatus's own dot uses. Primitive selectors so the trigger
  // re-renders only when the signal actually flips.
  const hasGateBlocks = usePreflightBlockStore((s) => s.blocks.length > 0);
  const hasHookNag = useHookStatusStore((s) => s.fires[0]?.exitCode === 2);
  const attention = hasGateBlocks || hasHookNag;

  // Outside-click + Esc dismissal (mirrors HookStatus / PreflightBlockLog). A
  // click on a NESTED popover (autonomy/gate/hooks) is inside panelRef in the
  // DOM, so the outer menu stays open while the inner popover handles its own
  // close — the two don't fight.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (panelRef.current?.contains(target ?? null)) return;
      if (triggerRef.current?.contains(target ?? null)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex items-center justify-center px-1.5 py-0.5 rounded text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title={attention
          ? "Diagnostics — attention needed (a gate block or hook nag fired). Autonomy, gate blocks, hooks, taste stats."
          : "Diagnostics — autonomy, gate blocks, hooks, taste stats"}
        aria-label={attention ? "Diagnostics — attention needed" : "Open diagnostics menu"}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
        {attention && (
          <span
            aria-hidden="true"
            data-testid="diagnostics-attention-dot"
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent-amber ring-1 ring-surface-secondary"
          />
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="group"
          aria-label="Diagnostics"
          className="absolute right-0 mt-1 w-60 max-w-[calc(100vw-1rem)] rounded-md border border-border-default bg-surface-elevated shadow-lg z-50 p-1"
        >
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            Diagnostics
          </div>
          <div className="flex flex-col">
            <div className="px-1 py-0.5">
              <AutonomySlider />
            </div>
            <div className="px-1 py-0.5">
              <PreflightBlockLog />
            </div>
            <div className="px-1 py-0.5">
              <HookStatus />
            </div>
            <div className="px-1 py-0.5">
              <CompoundingBadge onOpen={onOpenLedger} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
