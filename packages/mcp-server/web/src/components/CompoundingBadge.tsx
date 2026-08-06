import { apiGet, apiBase } from "../lib/api";
import { useLedgerStore } from "../stores/ledger";
import { useAbortableFetch } from "../hooks/useAbortableFetch";

/**
 * Compact "look how much you've taught it" stat — the felt proof that the moat
 * is compounding. #189 moved it OFF the header into the Diagnostics overflow.
 * #212 (J4) removed the top-level header "Ledger" button, so this IS now the
 * single entry to the Ledger drawer — it leads with the word "Ledger" (not a
 * bare stat) and carries the headline cumulative counts (pre-flight blocks +
 * ledger writes) inline. Clicking opens the drawer (via onOpen → the shared
 * dp:open-your-taste path the ⌘K palette + taste toasts also use).
 *
 * Refetches whenever the ledger store invalidates (a block fired / a stance
 * changed), so the count ticks up in the moment the taste compounds.
 */
export function CompoundingBadge({ onOpen }: { onOpen: () => void }) {

  // Bumped every time the ledger digest refetches (dp:preflight-trace, override) —
  // a cheap, existing "taste changed" signal to re-pull the cumulative counts.
  const ledgerVersion = useLedgerStore((s) => s.version);

  // E7 — abortable (the cancelled-flag left the request in-flight at
  // unmount; badge stays hidden if /api/metrics isn't reachable).
  const stat = useAbortableFetch(async (signal) => {
    const res = await apiGet(`${apiBase()}/api/metrics`, { signal });
    // Throw (not null) on failure: the hook keeps last-known counts through
    // a transient blip instead of unmounting the compounding proof.
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      blocks: data?.counts?.preflightBlocks?.total ?? 0,
      writes: data?.counts?.ledgerWrites?.total ?? 0,
    };
  }, [ledgerVersion]);

  if (!stat) return null;

  // E3 (L6) — a muted zero-state instead of self-hiding: new users never
  // learned the compounding meter existed because it only appeared once it
  // had something to show. Zero is honest AND teaches the affordance.
  const isZero = stat.blocks === 0 && stat.writes === 0;

  return (
    <button
      onClick={onOpen}
      title={isZero
        ? "Open the Ledger — your cross-project taste. Pre-flight blocks and ledger writes accumulate here across this project."
        : `Open the Ledger — your cross-project taste: ${stat.blocks} pre-flight block${stat.blocks === 1 ? "" : "s"} · ${stat.writes} ledger write${stat.writes === 1 ? "" : "s"} across this project.`}
      aria-label="Open the Ledger"
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-2xs text-text-muted
                 hover:text-text-secondary hover:bg-surface-hover transition-colors font-mono"
    >
      {/* #212 (J4) — leads with the word "Ledger" so, as the SINGLE ledger entry
          now, this reads unambiguously as the drawer's door rather than a bare
          stat. The cumulative counts trail inline once there's something to show
          (F1 — muted is the AA floor, no opacity stacking; E3 — a labelled
          zero-state still teaches the affordance instead of self-hiding). */}
      <span>🧭 Ledger</span>
      {!isZero && (
        <>
          <span className="text-border-default">·</span>
          <span>🛡 {stat.blocks}</span>
          <span className="text-border-default">·</span>
          <span>🧭 {stat.writes}</span>
        </>
      )}
    </button>
  );
}
