import { useEffect, useRef, useState } from "react";
import { useHookStatusStore, type HookFire } from "../stores/hookStatus";
import { useOverlayPresence } from "../stores/overlay";

/**
 * X7 — header chip + popover surfacing recent hook fires.
 *
 * The Stop and Checkpoint hooks usually run silently — pass or nag, the user
 * never sees the wire. That's good for not interrupting flow, bad for trust:
 * when something feels off ("did the agent just barrel past my checkpoint?")
 * there was nowhere to look. This chip exposes the firehose without forcing
 * it on anyone.
 *
 * Visual rules:
 * - Idle (no fires yet): muted dot, just "hooks".
 * - Last fire was a nag (exitCode === 2): amber dot.
 * - Last fire was a pass (exitCode === 0): green dot.
 * The chip never grows a counter — fires happen often enough that a number
 * would just be noise.
 */

const POPOVER_LIMIT = 5;

function formatRelative(at: string): string {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return "";
  const delta = Date.now() - t;
  if (delta < 5_000) return "just now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}

function fireKindLabel(fire: HookFire): { label: string; tone: "nag" | "pass" } {
  if (fire.exitCode === 2) return { label: "nag", tone: "nag" };
  return { label: "pass", tone: "pass" };
}

export function HookStatus() {
  const fires = useHookStatusStore((s) => s.fires);
  const [open, setOpen] = useState(false);
  useOverlayPresence(open); // UX4 — only while the popover is open (the chip is always mounted)
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Click-outside + Esc dismissal. The popover has no actions inside it
  // (read-only), so a click anywhere else should close it without ceremony.
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

  const latest = fires[0];
  const dotTone: "idle" | "nag" | "pass" = latest
    ? fireKindLabel(latest).tone
    : "idle";

  const dotClass =
    dotTone === "nag"
      ? "bg-accent-amber"
      : dotTone === "pass"
        ? "bg-accent-green"
        : "bg-text-muted/60";

  const recent = fires.slice(0, POPOVER_LIMIT);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title="Recent hook fires (Stop / Checkpoint)"
        aria-label="Show recent hook fires"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass} ${dotTone === "nag" ? "animate-pulse" : ""}`}
        />
        <span className="hidden min-[700px]:inline">hooks</span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-modal="true"
          aria-label="Recent hook fires"
          className="absolute right-0 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border-default bg-surface-elevated shadow-lg z-50 overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border-default flex items-center justify-between">
            <span className="text-2xs font-medium text-text-secondary">
              Recent hooks
            </span>
            <span className="text-[10px] text-text-muted">
              last {Math.min(recent.length, POPOVER_LIMIT)}
            </span>
          </div>
          {recent.length === 0 ? (
            <div className="px-3 py-4 text-2xs text-text-muted">
              No hook fires yet — the Stop and Checkpoint hooks will appear
              here as they run.
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y divide-border-default">
              {recent.map((fire) => {
                const kind = fireKindLabel(fire);
                const toneText =
                  kind.tone === "nag"
                    ? "text-accent-amber"
                    : "text-accent-green";
                return (
                  <li
                    key={`${fire.at}-${fire.hook}`}
                    className="px-3 py-2 text-2xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-text-primary truncate">
                        {fire.hook}
                      </span>
                      <span className={`shrink-0 font-medium ${toneText}`}>
                        {kind.label}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-text-muted">
                      <span className="truncate" title={fire.reason}>
                        {fire.reason || "—"}
                      </span>
                      <span
                        className="shrink-0 text-[10px]"
                        title={fire.at}
                      >
                        {formatRelative(fire.at)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
