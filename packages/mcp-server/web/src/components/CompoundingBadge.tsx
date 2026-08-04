import { apiGet, apiBase } from "../lib/api";
import { useLedgerStore } from "../stores/ledger";
import { useAbortableFetch } from "../hooks/useAbortableFetch";

/**
 * Compact "look how much you've taught it" stat — the felt proof that the moat
 * is compounding. #189 moved it OFF the header into the Diagnostics overflow;
 * the header keeps the ONE primary "Ledger" button. This is the STATS view of
 * that same Ledger (headline cumulative counts — pre-flight blocks + ledger
 * writes), and clicking it opens the exact same drawer the header opens (L9,
 * #194 — the label + tooltip now say so, so the two entries don't read as
 * unrelated).
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
        ? "Ledger stats — pre-flight blocks and ledger writes accumulate across this project. Opens the same Ledger as the header button."
        : `Ledger stats: ${stat.blocks} pre-flight block${stat.blocks === 1 ? "" : "s"} · ${stat.writes} ledger write${stat.writes === 1 ? "" : "s"} across this project. Opens the same Ledger as the header button.`}
      aria-label="Ledger stats — opens the same Ledger as the header button"
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-2xs text-text-muted
                 hover:text-text-secondary hover:bg-surface-hover transition-colors font-mono"
    >
      {isZero ? (
        // F1 — no opacity stacking: muted IS the floor of the AA ladder.
        // L9 (#194) — "Ledger stats" (not a bare "Ledger") so this overflow
        // entry doesn't read as a second, unrelated copy of the header's
        // primary "Ledger" button; both open the same drawer.
        <span>🛡 Ledger stats</span>
      ) : (
        <>
          <span>🛡 {stat.blocks}</span>
          <span className="text-border-default">·</span>
          <span>🧭 {stat.writes}</span>
        </>
      )}
    </button>
  );
}
