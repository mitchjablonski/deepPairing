import { useEffect, useState } from "react";
import { LedgerPanel, SeedAffordance } from "./ledger/LedgerPanel";
import { SessionBrowser } from "./SessionBrowser";
import { useArtifactStore } from "../stores/artifact";
import { useLedgerStore, ensureLedgerSubscriptions } from "../stores/ledger";

/**
 * BB7 — cold-start home. PMF council called the prior !hasArtifacts
 * fallback (SessionBrowser) the demo-moment killer: a user opening
 * deepPairing for the first time saw a list of past sessions, not the
 * cross-project moat that distinguishes deepPairing from Cursor 3 /
 * auto-memory. Now the moat IS the screen. Past sessions still live
 * here, behind a secondary tab — they're a search affordance, not the
 * answer to "why deepPairing".
 *
 * Two tabs:
 *   - "Your ledger"  (default) — LedgerPanel digest + AA9 SeedAffordance
 *   - "Past sessions"          — the existing SessionBrowser
 *
 * The ledger headline reuses the same component the Ledger drawer
 * renders so the user's first impression here matches their later
 * exploration in the drawer.
 */
type IdleTab = "ledger" | "sessions";

export function IdleHome() {
  const [tab, setTab] = useState<IdleTab>("ledger");
  // EE2 — subscribe to the shared ledger store. CC4's per-component
  // dp:preflight-trace listener moved into stores/ledger.ts so a single
  // refetch fans out to every subscriber (PreflightBreadcrumb +
  // LedgerDrawer + IdleHome) instead of one fetch per surface.
  useEffect(() => {
    ensureLedgerSubscriptions();
  }, []);
  const ledger = useLedgerStore((s) => s.digest);
  const error = useLedgerStore((s) => s.error);
  const refetchLedger = useLedgerStore((s) => s.refetch);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* CC3 — asymmetric tab weights. PMF council flagged equal-sized
          tabs as quietly inviting users to read "Your ledger" and "Past
          sessions" as peer surfaces ("two ways to look back"), which
          undercuts the moat positioning. The ledger is the headline; past
          sessions is a retrieval affordance. Style the primary tab large,
          the secondary as a smaller pill aligned right. */}
      <div className="border-b border-border-default px-5 pt-4 pb-0 flex items-center justify-between shrink-0">
        <PrimaryTab
          active={tab === "ledger"}
          onClick={() => setTab("ledger")}
          label="Ledger"
        />
        <SecondaryPill
          active={tab === "sessions"}
          // DD9 — one-direction switch. Pre-DD9 the pill toggled
          // (clicking sessions while on sessions snapped back to
          // ledger), which violates every tab UI convention. PrimaryTab
          // already handles "go back to ledger".
          onClick={() => setTab("sessions")}
          label="Past sessions"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "ledger" && (
          <div className="space-y-4">
            <LedgerPanel
              data={ledger}
              error={error}
              onJumpToArtifact={(artifactId) => {
                useArtifactStore.getState().selectArtifact(artifactId);
              }}
            />
            {/* DD10 — gate the cold-start seed affordance on a fresh
                ledger. Pre-DD10 the affordance kept rendering even
                after the user seeded their first rule, doubling up
                with the "Seeded by you" section DD1 added (and with
                the Ledger drawer's own empty-state-only
                seed affordance). After the first seed the LedgerPanel
                already shows the seeded list; the inline affordance
                becomes redundant chrome. */}
            {ledger && ledger.globalLedger.concepts === 0 && (
              <div className="px-5 pb-5">
                <SeedAffordance onSeeded={() => { void refetchLedger(); }} />
              </div>
            )}
          </div>
        )}
        {tab === "sessions" && <SessionBrowser />}
      </div>
    </div>
  );
}

function PrimaryTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-1 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
        active
          ? "border-accent-violet text-text-primary"
          : "border-transparent text-text-muted hover:text-text-secondary"
      }`}
    >
      {label}
    </button>
  );
}

function SecondaryPill({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  // DD9 — give the inactive state a faint border so the pill reads as
  // a control, not a label. Pre-DD9 the inactive pill had only a color
  // class — flush-right of an underlined PrimaryTab it visually parsed
  // as static text. The active state already had a border; mirror the
  // shape on inactive with a subtler tone.
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-1 px-2 py-0.5 rounded text-2xs border transition-colors ${
        active
          ? "bg-surface-elevated text-text-primary border-border-default"
          : "text-text-muted border-border-subtle hover:text-text-secondary hover:bg-surface-hover hover:border-border-default"
      }`}
    >
      {label}
    </button>
  );
}
