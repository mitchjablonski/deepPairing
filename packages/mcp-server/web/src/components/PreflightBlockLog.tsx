import { useEffect, useRef, useState } from "react";
import { usePreflightBlockStore, type PreflightBlockRecord } from "../stores/preflightBlocks";
import { useOverlayPresence } from "../stores/overlay";

/**
 * #169 — header chip + popover surfacing recent pre-flight GATE BLOCKS.
 *
 * When deepPairing refuses an agent proposal that matches a prior rejection, the
 * moment previously lived only in a 12s hero toast. That's the single most
 * distinctive thing the gate does — and it vanished. This chip persists each
 * block for the session so the firing survives the toast: what was blocked, the
 * concept, the prior reason, and when. Modeled on HookStatus (same a11y shape:
 * a read-only role="dialog" popover dismissed by Esc / outside-click).
 *
 * Visual rules:
 * - Idle (no blocks): muted dot, just "gate".
 * - One or more blocks this session: amber dot (the gate has fired).
 */

const POPOVER_LIMIT = 6;

function formatRelative(at: string): string {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return "";
  const delta = Date.now() - t;
  if (delta < 5_000) return "just now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}

function sourceLabel(block: PreflightBlockRecord): string {
  if (block.source === "team") {
    return block.addedBy ? `Team policy · added by ${block.addedBy}` : "Team policy";
  }
  return "Your personal taste";
}

function matchDetail(via: PreflightBlockRecord["via"]): string {
  switch (via) {
    case "concept": return "matched by underlying concept";
    case "require": return "missing team-required approach";
    case "avoid": return "matches a team 'avoid' rule";
    default: return "matched by surface name";
  }
}

export function PreflightBlockLog() {
  const blocks = usePreflightBlockStore((s) => s.blocks);
  const [open, setOpen] = useState(false);
  useOverlayPresence(open); // UX4 — only while the popover is open (the chip is always mounted)
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Click-outside + Esc dismissal — the popover is read-only, so a click
  // anywhere else closes it without ceremony (mirrors HookStatus).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (popoverRef.current?.contains(target ?? null)) return;
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

  const hasBlocks = blocks.length > 0;
  const dotClass = hasBlocks ? "bg-accent-amber" : "bg-text-muted/60";
  const recent = blocks.slice(0, POPOVER_LIMIT);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title="Recent pre-flight gate blocks"
        aria-label={hasBlocks ? `Show recent gate blocks (${blocks.length})` : "Show recent gate blocks"}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
        <span className="hidden min-[700px]:inline">gate</span>
        {hasBlocks && (
          <span className="min-[700px]:hidden text-[10px] font-semibold text-accent-amber">
            {blocks.length}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Recent gate blocks"
          className="absolute right-0 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border-default bg-surface-elevated shadow-lg z-50 overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border-default flex items-center justify-between">
            <span className="text-2xs font-medium text-text-secondary">
              Gate blocks
            </span>
            <span className="text-[10px] text-text-muted">
              this session
            </span>
          </div>
          {recent.length === 0 ? (
            <div className="px-3 py-4 text-2xs text-text-muted">
              No blocks yet — when deepPairing refuses a proposal that matches a
              stance you already rejected, it will appear here.
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y divide-border-default">
              {recent.map((block) => (
                <li key={block.id} className="px-3 py-2 text-2xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-text-primary break-words min-w-0">
                      "{block.concept}"
                    </span>
                    <span className="shrink-0 text-[10px] text-text-muted" title={block.at}>
                      {formatRelative(block.at)}
                    </span>
                  </div>
                  {block.proposal && block.proposal !== block.concept && (
                    <div className="mt-0.5 text-text-muted break-words">
                      <span className="text-text-muted/70">Proposed:</span> "{block.proposal}"
                    </div>
                  )}
                  {block.reason && (
                    <div className="mt-0.5 italic text-text-secondary break-words">
                      "{block.reason}"
                    </div>
                  )}
                  <div className="mt-1 text-[10px] text-text-muted">
                    {sourceLabel(block)} · {matchDetail(block.via)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
