import { useEffect, useRef, useState } from "react";
import {
  usePreflightBlockStore,
  unreadBlockCount,
  type PreflightBlockRecord,
} from "../stores/preflightBlocks";
import { useOverlayPresence } from "../stores/overlay";

/**
 * #169 — header chip + popover surfacing recent pre-flight GATE BLOCKS.
 *
 * When deepPairing refuses an agent proposal that matches a prior rejection, the
 * moment previously lived only in a 12s hero toast. That's the single most
 * distinctive thing the gate does — and it vanished. This chip persists each
 * block so the firing survives the toast: what was blocked, the concept, the
 * prior reason, and when. Modeled on HookStatus (same a11y shape: a read-only
 * role="dialog" popover dismissed by Esc / outside-click).
 *
 * Q2 — DURABLE, AND HONEST ABOUT WHAT YOU MISSED. Round 12: the store was
 * in-memory and session-scoped, so a block that fired while the tab was closed
 * (the normal case — the agent works without a browser attached) left no trace
 * anywhere, while the DEMO replayed its synthetic block to late joiners
 * forever. We now hydrate from the daemon's durable project log on mount, and
 * mark blocks that fired since you last looked as unread — the same
 * "N waiting on you" grammar the rest of the UI uses for a signal that needs
 * your eyes, rather than a count that just accumulates.
 *
 * Visual rules:
 * - Idle (no blocks): muted dot, just "gate".
 * - Blocks you've already read: amber dot (the gate has fired here).
 * - Blocks since you last looked: amber dot + pulse + unread count.
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
  const lastSeenAt = usePreflightBlockStore((s) => s.lastSeenAt);
  const loaded = usePreflightBlockStore((s) => s.loaded);
  const load = usePreflightBlockStore((s) => s.load);
  const markSeen = usePreflightBlockStore((s) => s.markSeen);
  const [open, setOpen] = useState(false);

  // Q2 — hydrate the durable log once. Fail-soft inside the store: a 404 or a
  // dead daemon leaves the chip in its idle state rather than breaking the header.
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Q2 — opening the popover IS reading it. Marking on open (not on hover, not
  // on a timer) keeps the unread count honest: it only clears when the human
  // actually looked at what fired.
  //
  // Q2 review LOW — gated on `loaded`. Opening the chip WHILE hydration was in
  // flight used to mark everything read: with `blocks` still empty, markSeen
  // falls back to stamping "now", which is newer than every block about to
  // arrive — so the durable blocks the human never saw landed pre-read, which
  // is exactly the disappearance this whole feature exists to stop. Waiting for
  // the hydrate means the boundary is always the real newest block; the effect
  // re-runs when `loaded` flips, so a popover opened early still marks correctly
  // the moment the list arrives.
  useEffect(() => {
    if (open && loaded) markSeen();
  }, [open, loaded, markSeen]);
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
  const unread = unreadBlockCount({ blocks, lastSeenAt });
  const dotClass = hasBlocks ? "bg-accent-amber" : "bg-text-muted/60";
  const recent = blocks.slice(0, POPOVER_LIMIT);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title={
          unread > 0
            ? `${unread} gate block${unread === 1 ? "" : "s"} waiting on you`
            : "Recent pre-flight gate blocks"
        }
        aria-label={
          unread > 0
            ? `Show recent gate blocks (${unread} waiting on you)`
            : hasBlocks
              ? `Show recent gate blocks (${blocks.length})`
              : "Show recent gate blocks"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass} ${unread > 0 ? "animate-pulse" : ""}`}
        />
        <span className="hidden min-[700px]:inline">gate</span>
        {/* Q2 — the unread count is the signal; a total that never clears is
            just a scoreboard. Falls back to the total on narrow widths where
            the "gate" label is hidden and the chip would otherwise be a bare dot. */}
        {unread > 0 ? (
          <span className="text-[10px] font-semibold text-accent-amber">{unread}</span>
        ) : (
          hasBlocks && (
            <span className="min-[700px]:hidden text-[10px] font-semibold text-accent-amber">
              {blocks.length}
            </span>
          )
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Recent gate blocks"
          data-testid="gate-block-log"
          /* R2 — IN FLOW, not floating. Round 13: this panel was
             `absolute right-0 mt-1 w-80 z-50`, and since #189 demoted the chip
             into the ⋯ diagnostics menu its siblings ("hooks", the Ledger pill)
             sit directly BELOW it in the same 240px column — so opening the
             gate log painted a 320px card straight over them and the hooks chip
             measured 1.0 hookCoveredFraction: completely unclickable while the
             moat's own log was open. Exactly the occlusion class Q4 fixed for
             diagram composers, and it took the same fix: render in the flow of
             the menu (DiagramRegionLayer's `relative z-[2] mt-2` block
             placement) so the panel PUSHES its siblings down instead of
             covering them. Occlusion then becomes impossible by construction at
             every viewport width — which the alternative (flipping the float to
             the left of the menu) is not, since a narrow window has no room on
             that side either. */
          className="relative z-[1] mt-1 w-full rounded-md border border-border-default bg-surface-elevated overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border-default flex items-center justify-between">
            <span className="text-2xs font-medium text-text-secondary">
              Gate blocks
            </span>
            {/* Q2 — "this project" is now the truth: the log is served from
                .deeppairing/preflight-blocks.json, so it spans sessions and
                survives a reload (and a closed browser at the moment it fired). */}
            <span className="text-[10px] text-text-muted">
              this project
            </span>
          </div>
          {recent.length === 0 ? (
            <div className="px-3 py-4 text-2xs text-text-muted">
              No blocks yet — when deepPairing refuses a proposal that matches a
              stance you already rejected, it will appear here. Blocks are kept
              even if this tab wasn’t open when the gate fired.
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
                      {/* R2 (contrast) — was `text-text-muted/70`: 3.02:1 dark
                          / 2.95:1 light on surface-elevated, the worst pairing
                          in the batch and, of all places, in the moat's own
                          panel. The alpha modifier was doing the job a token
                          should do (PendingBanner:113-117 documents this exact
                          class). A LABEL should read stronger than its value
                          anyway, so it steps UP to the solid secondary token:
                          8.29:1 dark / 8.77:1 light, and the row still reads as
                          label + quote because the value stays muted. */}
                      <span className="text-text-secondary">Proposed:</span> "{block.proposal}"
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
