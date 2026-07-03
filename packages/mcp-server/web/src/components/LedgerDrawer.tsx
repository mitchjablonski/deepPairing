import { useEffect, useState } from "react";
import { apiGet, apiBase } from "../lib/api";
import { useModal } from "../hooks/useModal";
import { useArtifactStore } from "../stores/artifact";
import { useLedgerStore, ensureLedgerSubscriptions } from "../stores/ledger";
import { LedgerPanel, SeedAffordance, FilterPill, EntryRow } from "./ledger/LedgerPanel";
import { DigestPanel } from "./ledger/DigestPanel";
import { TeamPanel } from "./ledger/TeamPanel";
import { isDigestEnabled } from "./ledger/types";
import type { Tab, PhilosophyEntry, DigestData, TeamPreferencesData, Filter } from "./ledger/types";

export function LedgerDrawer({
  onClose,
  initialTab,
  highlightConcept,
}: {
  onClose: () => void;
  // BB6 — when opened from a PreflightBreadcrumb deep-link, default the
  // tab to the ledger so the user lands on the right surface and the
  // matching row gets the violet ring + scrollIntoView.
  initialTab?: Tab;
  highlightConcept?: string;
}) {
  const { dialogProps } = useModal({ onClose });
  const [tab, setTab] = useState<Tab>(initialTab ?? "stances");
  const [entries, setEntries] = useState<PhilosophyEntry[] | null>(null);
  const [digest, setDigest] = useState<DigestData | null>(null);
  const [teamPrefs, setTeamPrefs] = useState<TeamPreferencesData | null>(null);
  // AA5 — ledger digest state. Lazy-loaded the first time the tab opens.
  // EE2 — drawer's ledger view subscribes to the shared store. Pre-EE2
  // the drawer kept its own local state and re-fetched on first tab
  // visit; with IdleHome + PreflightBreadcrumb both also fetching, the
  // user could pay 3 roundtrips for the same digest. Now: one fetch,
  // all surfaces in sync.
  const ledger = useLedgerStore((s) => s.digest);
  const ledgerError = useLedgerStore((s) => s.error);
  const [error, setError] = useState<string | null>(null);
  const [digestError, setDigestError] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");


  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await apiGet(`${apiBase()}/api/philosophy?limit=200`, { signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!ac.signal.aborted) setEntries(data.entries ?? []);
      } catch (err: any) {
        if (!ac.signal.aborted) setError(err?.message ?? String(err));
      }
    })();
    return () => ac.abort();
  }, []);

  // Lazy-load the digest the first time the tab is opened.
  useEffect(() => {
    if (tab !== "digest" || digest !== null || digestError !== null) return;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await apiGet(`${apiBase()}/api/philosophy/digest?sinceDays=7`, { signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!ac.signal.aborted) setDigest(data);
      } catch (err: any) {
        if (!ac.signal.aborted) setDigestError(err?.message ?? String(err));
      }
    })();
    return () => ac.abort();
  }, [tab, digest, digestError]);

  // EE2 — wiring the shared store handles fetch + dp:preflight-trace
  // refetch + cross-surface sync. Trigger an explicit refetch on first
  // ledger-tab visit so a stale digest from earlier in the session
  // gets refreshed even if no trace event has fired since last view.
  useEffect(() => {
    ensureLedgerSubscriptions();
  }, []);
  useEffect(() => {
    if (tab === "ledger") {
      void useLedgerStore.getState().refetch();
    }
  }, [tab]);

  // P3 — lazy-load team preferences on first tab visit.
  useEffect(() => {
    if (tab !== "team" || teamPrefs !== null || teamError !== null) return;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await apiGet(`${apiBase()}/api/team-preferences`, { signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!ac.signal.aborted) setTeamPrefs(data);
      } catch (err: any) {
        if (!ac.signal.aborted) setTeamError(err?.message ?? String(err));
      }
    })();
    return () => ac.abort();
  }, [tab, teamPrefs, teamError]);

  const filtered = (entries ?? []).filter((e) => (filter === "all" ? true : e.stance === filter));
  const avoid = (entries ?? []).filter((e) => e.stance === "avoid").length;
  const prefer = (entries ?? []).filter((e) => e.stance === "prefer").length;
  const mixed = (entries ?? []).filter((e) => e.stance === "mixed").length;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        {...dialogProps}
        aria-label="Ledger"
        className="fixed top-0 right-0 bottom-0 z-50 w-[420px] max-w-[90vw]
                   bg-surface-elevated border-l border-border-default shadow-2xl
                   overflow-y-auto focus:outline-none"
      >
        <div className="sticky top-0 flex items-center justify-between px-5 py-3 border-b border-border-default bg-surface-elevated">
          <div>
            <h2 className="text-sm font-bold text-text-primary">Ledger</h2>
            <div className="text-2xs text-text-muted mt-0.5">Cross-project Philosophy Ledger</div>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-2xs"
            title="Close (Esc)"
          >
            Esc
          </button>
        </div>

        {/* O3: Digest tab gated behind VITE_DP_SHOW_DIGEST until we have
            enough real-user data for the compounding view to feel meaningful
            (target: 4+ weeks of usage). The route /api/philosophy/digest
            still works for anyone who opts in. */}
        <div className="px-5 pt-3 border-b border-border-default flex gap-1">
          <TabButton active={tab === "stances"} onClick={() => setTab("stances")} label="Stances" />
          {/* AA5 — Ledger tab is the cross-project moat surface. Always
              visible (unlike the gated Digest tab) because the value
              shows up from session #1 once Z1's traces exist. */}
          <TabButton active={tab === "ledger"} onClick={() => setTab("ledger")} label="History" />
          {isDigestEnabled() && (
            <TabButton active={tab === "digest"} onClick={() => setTab("digest")} label="This week" />
          )}
          <TabButton active={tab === "team"} onClick={() => setTab("team")} label="Team" />
        </div>

        {tab === "stances" && (
          <>
            <div className="px-5 py-3 border-b border-border-default flex gap-1 flex-wrap">
              <FilterPill active={filter === "all"} onClick={() => setFilter("all")} label={`All (${entries?.length ?? 0})`} />
              <FilterPill active={filter === "avoid"} onClick={() => setFilter("avoid")} label={`Avoid (${avoid})`} tone="red" />
              <FilterPill active={filter === "prefer"} onClick={() => setFilter("prefer")} label={`Prefer (${prefer})`} tone="green" />
              <FilterPill active={filter === "mixed"} onClick={() => setFilter("mixed")} label={`Mixed (${mixed})`} />
            </div>

            <div className="p-5">
              {error && (
                <div className="text-xs text-accent-red">
                  Could not load the ledger: {error}
                </div>
              )}
              {!error && entries === null && (
                <div className="text-xs text-text-muted">Loading…</div>
              )}
              {!error && entries !== null && entries.length === 0 && (
                <div className="space-y-4">
                  <div className="text-xs text-text-muted leading-relaxed">
                    <p className="mb-2 font-medium text-text-secondary">Nothing here yet.</p>
                    <p>
                      Every time you reject or approve a concept in a deepPairing session,
                      it lands here. After a few sessions the ledger starts compounding —
                      rejected approaches from other projects carry forward as avoid stances,
                      and your taste becomes visible.
                    </p>
                  </div>
                  {/* AA9 — opt-in seed affordance. PMF council deep dive
                      rejected pre-seeded stance picks (anti-thesis,
                      culturally contested) and proposed this instead:
                      let the user paste a rule from their CLAUDE.md /
                      code-review checklist / team doc. Active accumulation,
                      zero presupposed taste. */}
                  <SeedAffordance onSeeded={() => {
                    // Refetch the stance list so the just-seeded entry
                    // appears immediately. Re-using the same fetch shape
                    // the mount effect uses.
                    apiGet(`${apiBase()}/api/philosophy?limit=200`)
                      .then((r) => r.ok ? r.json() : null)
                      .then((data) => {
                        if (data) setEntries(data.entries ?? []);
                      })
                      .catch(() => {});
                  }} />
                </div>
              )}
              {!error && filtered.length > 0 && (
                <ul className="space-y-3">
                  {filtered.map((e) => (
                    <EntryRow key={e.key} entry={e} />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {tab === "ledger" && (
          <LedgerPanel
            data={ledger}
            error={ledgerError}
            highlightConcept={highlightConcept}
            onJumpToArtifact={(artifactId) => {
              // BB6 — round-trip backlink. Click a top-cited stance, jump
              // to a real artifact that cited it. Closes the drawer so
              // the user lands directly on the artifact panel.
              useArtifactStore.getState().selectArtifact(artifactId);
              onClose();
            }}
          />
        )}

        {tab === "digest" && isDigestEnabled() && <DigestPanel digest={digest} error={digestError} />}

        {tab === "team" && <TeamPanel data={teamPrefs} error={teamError} />}
      </div>
    </>
  );
}

function TabButton({
  active, onClick, label,
}: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-2xs font-medium transition-colors border-b-2 ${
        active
          ? "text-text-primary border-accent-blue"
          : "text-text-muted border-transparent hover:text-text-secondary"
      }`}
    >
      {label}
    </button>
  );
}
