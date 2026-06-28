import { useToastStore, type Toast, type PreflightBlockHero } from "../stores/toast";
import { useLedgerStore } from "../stores/ledger";

const kindStyles: Record<Toast["kind"], { bg: string; border: string; accent: string; icon: string }> = {
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
    icon: "🛡",
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

function PreflightBlockHeroCard({ hero, onDismiss, action, onOverride }: {
  hero: PreflightBlockHero;
  onDismiss: () => void;
  action?: { label: string; onClick: () => void };
  /** Scope-down this block as a false positive (personal stances only). */
  onOverride?: () => void;
}) {
  const style = kindStyles["preflight-block"];
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
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-start gap-2">
        <span className="text-base shrink-0" aria-hidden="true">{style.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-text-primary">
            {hero.source === "team" ? "Blocked by team policy" : "Blocked by your taste"}
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

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-border-default/40 pl-6">
        <div className="text-[10px] text-text-muted">
          <span>{sourceLabel}</span>
          {when && <> · {when}</>}
          {hero.projectCount && hero.projectCount > 1 && <> · {hero.projectCount} projects</>}
          <span> · {matchDetail}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* Scope-down a false positive. The gate is fuzzy by design, so this
              is the safety valve — personal stances only. Team rules live in a
              committed file, so we point the user there instead of mutating it. */}
          {hero.source === "session" && onOverride && (
            <button
              onClick={() => { onOverride(); onDismiss(); }}
              title="False positive? Scope this stance down so it stops blocking — and the ledger learns the correction."
              className="text-2xs font-medium text-text-muted hover:text-text-secondary hover:underline"
            >
              Not my taste
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

/**
 * Bottom-right toast stack. Renders above the MessageInput so ephemeral
 * notifications don't compete with the main artifact surface for attention.
 */
export function ToastLayer() {
  const { toasts, dismiss } = useToastStore();

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
      className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-[420px] w-[calc(100vw-2rem)] pointer-events-none"
    >
      {toasts.map((t) => {
        // error / blocked are assertive — they interrupt rather than queue
        // behind polite chatter.
        const assertive = t.kind === "error" || t.kind === "block" || t.kind === "preflight-block";
        // Hero shape for the rejection-block moment — the most distinctive
        // thing deepPairing does; it deserves the larger card.
        if (t.kind === "preflight-block" && t.hero) {
          // PreflightBlockHeroCard is already role="alert" internally — the
          // wrapper only restores pointer events (parent is pointer-events-none).
          return (
            <div key={t.id} className="pointer-events-auto">
              <PreflightBlockHeroCard
                hero={t.hero}
                onDismiss={() => dismiss(t.id)}
                action={t.action}
                onOverride={() =>
                  void useLedgerStore.getState().overrideStance({
                    source: t.hero!.source,
                    description: t.hero!.description,
                    concept: t.hero!.concept,
                  })
                }
              />
            </div>
          );
        }
        const style = kindStyles[t.kind];
        return (
          <div
            key={t.id}
            role={assertive ? "alert" : "status"}
            aria-live={assertive ? "assertive" : "polite"}
            className={`pointer-events-auto flex items-start gap-2 px-3 py-2.5 rounded-lg border shadow-lg backdrop-blur-sm animate-fade-in ${style.bg} ${style.border}`}
          >
            <span className={`text-sm font-semibold shrink-0 ${style.accent}`}>{style.icon}</span>
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
