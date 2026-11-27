import { useEffect, useId, useRef } from "react";

/**
 * #714 gap 9 — the page review's keyboard shortcuts, as a small popover
 * beside its toggle (the "Shortcuts" button on the pointing bar, or ? pressed
 * inside the page). On a phone-width screen it is pinned inside the viewport
 * (16px gutters) instead, so it never adds a horizontal scroll. Escape or a
 * click outside closes it and hands focus back to the toggle. The app-wide ?
 * help lists the same keys.
 */
export const PAGE_REVIEW_SHORTCUTS: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: "C", description: "Keyboard comment mode on / off (focus moves into the page)" },
  { keys: "↓ → / Tab", description: "Comment mode: next block" },
  { keys: "↑ ← / ⇧Tab", description: "Comment mode: previous block" },
  { keys: "Home / End", description: "Comment mode: first / last block" },
  { keys: "Enter", description: "Comment mode: comment on the block" },
  { keys: "Esc", description: "Leave comment mode · close the composer · collapse the expanded view" },
  { keys: "] / [", description: "Next / previous comment in the list" },
  { keys: "⌘I / Ctrl+I", description: "Pointing on / off" },
  { keys: "?", description: "These shortcuts (inside the page)" },
];

export function PageShortcutHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    popRef.current?.focus?.();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || toggleRef.current?.contains(t))) return;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onOpenChange]);
  return (
    <span className="relative inline-flex">
      <button
        ref={toggleRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-keyshortcuts="?"
        className="px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary pointer-coarse:min-h-11"
        data-testid="page-shortcuts-toggle"
      >
        Shortcuts <kbd className="ml-0.5 font-mono text-[9px] text-text-muted">?</kbd>
      </button>
      {open && (
        <div
          ref={popRef}
          id={id}
          role="dialog"
          aria-label="Page review keyboard shortcuts"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            onOpenChange(false);
            toggleRef.current?.focus?.();
          }}
          className="fixed left-4 right-4 top-20 z-50 sm:absolute sm:left-0 sm:right-auto sm:top-full sm:mt-1 sm:z-30 sm:w-80 max-h-[70vh] overflow-y-auto p-2.5 rounded-lg border border-border-default bg-surface-elevated shadow-lg space-y-1 focus:outline-none"
          data-testid="page-shortcuts-popover"
        >
          <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide">Page review shortcuts</div>
          <dl className="space-y-1">
            {PAGE_REVIEW_SHORTCUTS.map((s) => (
              <div key={s.keys} className="flex items-start justify-between gap-3">
                <dt className="shrink-0">
                  <kbd className="px-1.5 py-0.5 bg-surface-primary border border-border-default rounded text-2xs font-mono text-text-secondary">
                    {s.keys}
                  </kbd>
                </dt>
                <dd className="text-2xs text-text-secondary text-right">{s.description}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </span>
  );
}
