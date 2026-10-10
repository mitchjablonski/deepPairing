import type React from "react";
import type { ReactNode } from "react";
import { useToastStore, type Toast, type PreflightBlockHero } from "../stores/toast";
import { useEffect } from "react";
import { useAllowOnceStore } from "../stores/allowOnce";
import { usePreflightBlockStore } from "../stores/preflightBlocks";
import { usePreferencesStore } from "../stores/preferences";
import { ineligibleText, openGateLogEntry } from "../lib/stanceException";
import { useCrossProjectStore } from "../stores/crossProject";
import { ShieldIcon, CompassIcon } from "./icons/ArtifactIcons";
import { useOfflineReason } from "../hooks/useOfflineReason";

/**
 * R2 — the SVG marks a toast can name via `Toast.icon`, so a store that can't
 * hold JSX (stores/connection.ts, stores/ledger.ts) can still ask for one
 * instead of pasting an emoji into the title string.
 */
const NAMED_ICONS: Record<NonNullable<Toast["icon"]>, ReactNode> = {
  compass: <CompassIcon className="w-4 h-4" />,
  shield: <ShieldIcon className="w-4 h-4" />,
};

const kindStyles: Record<Toast["kind"], { bg: string; border: string; accent: string; icon: ReactNode }> = {
  info: {
    bg: "bg-accent-blue-dim/40",
    border: "border-accent-blue/30",
    accent: "text-accent-blue",
    icon: "ⓘ",
  },
  success: {
    bg: "bg-accent-green-dim/40",
    border: "border-accent-green/30",
    accent: "text-accent-green",
    icon: "✓",
  },
  block: {
    bg: "bg-accent-violet-dim/40",
    border: "border-accent-violet/30",
    accent: "text-accent-violet",
    // Memory symbol — the pre-flight moat in a glyph
    icon: "⛶",
  },
  "preflight-block": {
    bg: "bg-accent-violet-dim/60",
    border: "border-accent-violet/60",
    accent: "text-accent-violet",
    // Q4 (round-12 UX #5) — was the 🛡 emoji, which renders as tofu wherever a
    // colour-emoji font is missing. This is the hero of the block moment (the
    // product's loudest claim); it can't be a blank square. Inline SVG,
    // currentColor, so it takes the violet accent from its span.
    icon: <ShieldIcon className="w-4 h-4" />,
  },
  error: {
    bg: "bg-accent-red-dim/40",
    border: "border-accent-red/30",
    accent: "text-accent-red",
    icon: "!",
  },
};

function humanizeAge(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 60) return "1 month ago";
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function PreflightBlockHeroCard({ hero, onDismiss, action, toastId }: {
  hero: PreflightBlockHero;
  onDismiss: () => void;
  action?: { label: string; onClick: () => void };
  /** #470 — the toast's id, so the dialog it opens can pause its auto-dismiss. */
  toastId?: string;
}) {
  const offline = useOfflineReason(); // #487 review — act paths gate on the shared offline condition (#467)
  const style = kindStyles["preflight-block"];
  // #501 review (Fable HIGH) — the toast follows its block's receipt: once
  // allowed (or changed), the action is gone, the card says so, and it leaves
  // on the normal timer however it was held (the dialog's return focus too).
  const receipt = usePreflightBlockStore((s) =>
    hero.blockId ? s.blocks.find((b) => (b.serverId ?? b.id) === hero.blockId)?.allowance : undefined);
  const receiptState = receipt?.state;
  const barOn = usePreferencesStore((s) => s.nextUpBar);
  useEffect(() => {
    if (receiptState && toastId) useToastStore.getState().settle(toastId, RECEIPT_TTL_MS);
  }, [receiptState, toastId]);
  const when = humanizeAge(hero.rejectedAt);
  const sourceLabel = hero.source === "team"
    ? hero.addedBy
      ? `Team policy (added by ${hero.addedBy})`
      : "Team policy"
    : "Your personal taste";
  const matchDetail = hero.via === "concept"
    ? "matched by underlying concept"
    : hero.via === "require"
      ? "missing team-required approach"
      : hero.via === "avoid"
        ? "matches a team 'avoid' rule"
        : "matched by surface name";

  return (
    <div
      className={`flex flex-col gap-2 px-4 py-3 rounded-lg border-2 shadow-xl backdrop-blur-sm animate-fade-in ${style.bg} ${style.border}`}
      // Once acted on, the moment was already spoken (one announcer); the
      // receipt text must not re-announce as an alert.
      role={receipt ? undefined : "alert"}
      aria-live={receipt ? undefined : "assertive"}
      data-testid="hero-toast"
    >
      <div className="flex items-start gap-2">
        <span className={`flex items-center text-base shrink-0 ${style.accent}`} aria-hidden="true">{style.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-text-primary">
            {receipt ? receiptTitle(receipt.state) : hero.source === "team" ? "Blocked by team policy" : "Blocked by your taste"}
          </div>
          <div className={`text-2xs font-semibold mt-0.5 ${style.accent} break-words`}>
            "{hero.concept}"
          </div>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-text-muted hover:text-text-primary text-xs px-1 shrink-0"
        >
          ✕
        </button>
      </div>

      {(hero.reason || hero.proposal) && (
        <div className="text-2xs text-text-secondary leading-relaxed space-y-1 pl-6">
          {hero.proposal && hero.proposal !== hero.concept && (
            <div>
              <span className="text-text-muted">Proposed:</span> "{hero.proposal}"
            </div>
          )}
          {hero.reason && (
            <div className="italic">"{hero.reason}"</div>
          )}
        </div>
      )}

      {/* #501 review (Fable MED) — the meta line gets its own row and the
          actions sit UNDER it, so the 32px primary button never squeezes the
          meta into one word per line. */}
      <div className="flex flex-col gap-2 pt-1 border-t border-border-default/40 pl-6">
        <div className="text-[10px] text-text-muted">
          <span>{sourceLabel}</span>
          {when && <> · {when}</>}
          {hero.projectCount && hero.projectCount > 1 && <> · {hero.projectCount} projects</>}
          <span> · {matchDetail}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* #501 round 3 — the ONE place a receipt shows while this toast is
              up. With the bar off this line is the announcement (a polite
              status that exists before its text arrives); with the bar on the
              bar's announcer speaks and this stays silent. */}
          <span
            className={`text-2xs font-semibold text-text-primary ${receipt ? "" : "sr-only"}`}
            data-testid="hero-receipt"
            role={barOn ? undefined : "status"}
            aria-live={barOn ? undefined : "polite"}
          >
            {receipt ? receiptHeadline(receipt.state, receipt.grantedVia) : ""}
          </span>
          {/* #470 (§3a) — "Allow this proposal once" is the PRIMARY action:
              filled, accent, a 32px target. Retire is NOT offered here any
              more: it was a one-click muted link right where a misclick lands,
              and it deletes the stance everywhere. It now lives on the gate-log
              entry ("More options"), behind a confirm whose focus starts on
              Cancel. Only a block the daemon says is eligible gets the button;
              any other personal block says why in one line. */}
          {hero.source === "session" && hero.blockId && hero.eligible && !receipt && (
            <button
              type="button"
              disabled={!!offline}
              onClick={(e) =>
                useAllowOnceStore.getState().open({ blockId: hero.blockId!, concept: hero.concept, returnFocusTo: e.currentTarget, toastId })}
              title={offline ?? "Let this exact proposal through once. The stance stays on for everything else."}
              className="min-h-[32px] min-w-[32px] px-3 rounded bg-accent-violet text-white text-2xs font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Allow this proposal once
            </button>
          )}
          {hero.source === "session" && hero.blockId && hero.eligible === false && !receipt && (
            <span className="text-[10px] text-text-muted italic" data-testid="allow-once-ineligible-line">{ineligibleText(hero.ineligibleReason)}</span>
          )}
          {hero.source === "session" && (
            <button
              type="button"
              onClick={() => openGateLogEntry(hero.blockId)}
              className="text-2xs font-medium text-text-muted cursor-pointer hover:text-text-secondary hover:underline"
            >
              More options
            </button>
          )}
          {hero.source === "team" && (
            <span
              className="text-[10px] text-text-muted italic"
              title="Team rules are committed — edit .deeppairing/team.json to change them."
            >
              edit team.json
            </span>
          )}
          {action && (
            <button
              onClick={action.onClick}
              className={`text-2xs font-medium hover:underline ${style.accent}`}
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** #501 review (Fable HIGH) — a toast whose block was acted on leaves after
 *  this long, whatever held it. */
export const RECEIPT_TTL_MS = 6000;

function receiptTitle(state: string): string {
  return state === "changed" ? "The proposal you allowed changed" : state === "used" ? "Claude used your allowance" : "Allowed once";
}
function receiptHeadline(state: string, via?: string): string {
  return state === "changed" ? "A new block is waiting — allow it there if you still want it."
    : state === "used" ? "Used once. The stance stays on for everything else."
    : state === "allowed" ? (via === "cli" ? "Granted from the command line. Claude can retry this proposal." : "Claude can retry this proposal.")
    : `Allowance ${state}.`;
}

/** #470 (§3a) — a toast's auto-dismiss pauses while it has hover or focus.
 *  #501 review (Fable HIGH) — focus that the dialog RETURNS on close is not
 *  the reader and holds nothing. */
const focusHeld = new Set<string>();
function holdHandlers(id: string) {
  const { pause, resume, consumeSkipFocusHold } = useToastStore.getState();
  return {
    onMouseEnter: () => pause(id),
    onMouseLeave: () => resume(id),
    onFocus: (e: React.FocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      if (consumeSkipFocusHold(id) || focusHeld.has(id)) return;
      focusHeld.add(id);
      pause(id);
    },
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null) || !focusHeld.delete(id)) return;
      resume(id);
    },
  };
}

/**
 * Bottom-right toast stack. Renders above the MessageInput so ephemeral
 * notifications don't compete with the main artifact surface for attention.
 */
export function ToastLayer() {
  const { toasts, dismiss } = useToastStore();
  const logOpen = usePreflightBlockStore((s) => s.logOpen);
  /**
   * R2 — the first-reject cross-project card shares this exact corner and now
   * sits ABOVE this layer (z-[70] vs z-[60]) because it is the rarer, more
   * consequential surface. Burying the toasts under it would only move the
   * occlusion, so the stack lifts by the card's measured height instead and
   * both stay readable. 0 when the card isn't on screen (and in jsdom, where
   * offsetHeight is always 0) → the normal bottom-4 placement, unchanged.
   */
  const cardHeight = useCrossProjectStore((s) => (s.cardVisible ? s.cardHeight : 0));
  const liftPx = cardHeight > 0 ? cardHeight + 24 : undefined;

  // U1 — announcement is per-toast, NOT via an outer live region: error/block/
  // preflight toasts are role=alert (assertive, announced on insertion); the
  // rest are role=status (polite). The wrapper is a plain positioning container
  // — making it ALSO an aria-live region would nest live regions, which double-
  // announces and downgrades the assertive toasts to the wrapper's politeness.
  // (The robust-but-heavier alternative is two persistent sr-only regions,
  // polite + assertive, with text routed in; per-toast roles suffice here.)
  // U2 — z-[60] sits above modals/drawers (z-50) so a failure toast fired while
  // an overlay is open is visible, not painted behind the backdrop.
  // pointer-events-none on the (wide) wrapper + auto per toast so it never
  // intercepts clicks over content behind it.
  return (
    <div
      data-testid="toast-region"
      className="fixed bottom-4 right-4 z-[60] flex flex-col justify-end gap-2 max-w-[420px] w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-hidden pointer-events-none"
      style={liftPx ? { bottom: liftPx } : undefined}
    >
      {toasts.map((t) => {
        // error / blocked are assertive — they interrupt rather than queue
        // behind polite chatter.
        const assertive = t.kind === "error" || t.kind === "block" || t.kind === "preflight-block";
        // Hero shape for the rejection-block moment — the most distinctive
        // thing deepPairing does; it deserves the larger card.
        // #501 round 3 (Fable MED) — the gate log lists these same blocks;
        // while it's open the block toasts step aside instead of covering it.
        if (t.kind === "preflight-block" && logOpen) return null;
        if (t.kind === "preflight-block" && t.hero) {
          // PreflightBlockHeroCard is already role="alert" internally — the
          // wrapper only restores pointer events (parent is pointer-events-none).
          return (
            <div key={t.id} className="pointer-events-auto outline-none" tabIndex={-1} data-toast-id={t.id} {...holdHandlers(t.id)}>
              <PreflightBlockHeroCard
                hero={t.hero}
                onDismiss={() => dismiss(t.id)}
                action={t.action}
                toastId={t.id}
              />
            </div>
          );
        }
        const style = kindStyles[t.kind];
        // R2 — a named SVG mark overrides the kind's default glyph. See the
        // `icon` field on Toast for why the ledger toasts needed one.
        const icon = t.icon ? NAMED_ICONS[t.icon] : style.icon;
        return (
          <div
            key={t.id}
            // #470 — a quiet toast was already spoken by the one announcer.
            role={t.quiet ? undefined : assertive ? "alert" : "status"}
            aria-live={t.quiet ? undefined : assertive ? "assertive" : "polite"}
            data-testid={t.strong ? "toast-strong" : undefined}
            {...holdHandlers(t.id)}
            className={`pointer-events-auto flex items-start gap-2 px-3 py-2.5 rounded-lg border shadow-lg backdrop-blur-sm animate-fade-in ${style.bg} ${style.border} ${t.strong ? "border-2 ring-1 ring-accent-amber/60" : ""}`}
          >
            {/* Q4 — decorative: the toast's title/body carry the message, and
                the role=alert already announces them. */}
            <span className={`flex items-center text-sm font-semibold shrink-0 ${style.accent}`} aria-hidden="true">{icon}</span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-text-primary">{t.title}</div>
              {t.body && (
                <div className="text-2xs text-text-secondary mt-0.5 whitespace-pre-wrap break-words">
                  {t.body}
                </div>
              )}
              {t.action && (
                <button
                  onClick={t.action.onClick}
                  className={`mt-1 text-2xs font-medium hover:underline ${style.accent}`}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="text-text-muted hover:text-text-primary text-xs px-1 shrink-0"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
