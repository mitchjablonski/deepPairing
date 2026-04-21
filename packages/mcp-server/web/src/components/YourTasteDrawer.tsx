import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

// O3: Weekly Digest is gated until real users have accumulated 4+ weeks of
// ledger activity — otherwise the "new / strengthened" lists look embarrassing
// and undersell the moat. Flip via `VITE_DP_SHOW_DIGEST=1`, or in tests via
// `window.__DP_FORCE_DIGEST__ = true`.
function isDigestEnabled(): boolean {
  if (typeof window !== "undefined" && (window as any).__DP_FORCE_DIGEST__) return true;
  const env = (import.meta as any)?.env?.VITE_DP_SHOW_DIGEST;
  return Boolean(env && env !== "0" && env !== "false");
}

/**
 * N3.1 + N3.2 — "Your taste" drawer. Makes the invisible Philosophy Ledger
 * moat felt. Two tabs:
 *   - Stances: static view of every concept + its derived stance
 *   - Digest:  what changed in the last N days (new + strengthened)
 *
 * Read-only. Mutations happen implicitly during sessions (every rejected
 * approach + approved pattern flows to the ledger). The reason ledger
 * entries compound — they span projects and survive beyond any one session
 * — is why this view exists. Without it, the compounding is invisible.
 */

interface PhilosophyEntry {
  key: string;
  concept: string;
  stance: "avoid" | "prefer" | "mixed";
  projectCount: number;
  projects: string[];
  instanceCount: number;
  approved: number;
  rejected: number;
  latestReason?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface DigestData {
  window: { sinceDays: number; fromIso: string; toIso: string };
  totals: { concepts: number; instances: number; multiProjectConcepts: number };
  newThisPeriod: Array<{ key: string; concept: string; stance: string; projectCount: number; latestReason?: string }>;
  strengthenedThisPeriod: Array<{ key: string; concept: string; stance: string; projectCount: number; newInstancesInPeriod: number; latestReason?: string }>;
}

type Filter = "all" | "avoid" | "prefer" | "mixed";
type Tab = "stances" | "digest";

export function YourTasteDrawer({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("stances");
  const [entries, setEntries] = useState<PhilosophyEntry[] | null>(null);
  const [digest, setDigest] = useState<DigestData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [digestError, setDigestError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useFocusTrap(panelRef, true);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`http://${window.location.host}/api/philosophy?limit=200`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setEntries(data.entries ?? []);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazy-load the digest the first time the tab is opened.
  useEffect(() => {
    if (tab !== "digest" || digest !== null || digestError !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`http://${window.location.host}/api/philosophy/digest?sinceDays=7`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setDigest(data);
      } catch (err: any) {
        if (!cancelled) setDigestError(err?.message ?? String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [tab, digest, digestError]);

  const filtered = (entries ?? []).filter((e) => (filter === "all" ? true : e.stance === filter));
  const avoid = (entries ?? []).filter((e) => e.stance === "avoid").length;
  const prefer = (entries ?? []).filter((e) => e.stance === "prefer").length;
  const mixed = (entries ?? []).filter((e) => e.stance === "mixed").length;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        role="dialog"
        aria-label="Your taste"
        className="fixed top-0 right-0 bottom-0 z-50 w-[420px] max-w-[90vw]
                   bg-surface-elevated border-l border-border-default shadow-2xl
                   overflow-y-auto focus:outline-none"
      >
        <div className="sticky top-0 flex items-center justify-between px-5 py-3 border-b border-border-default bg-surface-elevated">
          <div>
            <h2 className="text-sm font-bold text-text-primary">Your taste</h2>
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
        {isDigestEnabled() && (
          <div className="px-5 pt-3 border-b border-border-default flex gap-1">
            <TabButton active={tab === "stances"} onClick={() => setTab("stances")} label="Stances" />
            <TabButton active={tab === "digest"} onClick={() => setTab("digest")} label="This week" />
          </div>
        )}

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
                <div className="text-xs text-text-muted leading-relaxed">
                  <p className="mb-2 font-medium text-text-secondary">Nothing here yet.</p>
                  <p>
                    Every time you reject or approve a concept in a deepPairing session,
                    it lands here. After a few sessions the ledger starts compounding —
                    rejected approaches from other projects carry forward as avoid stances,
                    and your taste becomes visible.
                  </p>
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

        {tab === "digest" && isDigestEnabled() && <DigestPanel digest={digest} error={digestError} />}
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

function DigestPanel({ digest, error }: { digest: DigestData | null; error: string | null }) {
  if (error) {
    return (
      <div className="p-5 text-xs text-accent-red">
        Could not load the digest: {error}
      </div>
    );
  }
  if (!digest) {
    return <div className="p-5 text-xs text-text-muted">Loading…</div>;
  }
  const hasNew = digest.newThisPeriod.length > 0;
  const hasStrengthened = digest.strengthenedThisPeriod.length > 0;
  return (
    <div className="p-5 space-y-5">
      {/* Headline numbers */}
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="concepts" value={digest.totals.concepts} />
        <StatTile label="instances" value={digest.totals.instances} />
        <StatTile label="multi-project" value={digest.totals.multiProjectConcepts} />
      </div>

      <div className="text-2xs text-text-muted">
        Window: last {digest.window.sinceDays} days
      </div>

      {/* Empty state */}
      {!hasNew && !hasStrengthened && (
        <div className="text-xs text-text-muted leading-relaxed">
          Nothing landed in the ledger this week. The digest will fill in as
          you reject or approve approaches in live sessions.
        </div>
      )}

      {/* New this period */}
      {hasNew && (
        <section>
          <div className="text-2xs font-semibold text-text-secondary uppercase tracking-wide mb-2">
            New stances ({digest.newThisPeriod.length})
          </div>
          <ul className="space-y-2">
            {digest.newThisPeriod.map((e) => (
              <DigestEntry key={e.key} concept={e.concept} stance={e.stance} projectCount={e.projectCount} reason={e.latestReason} />
            ))}
          </ul>
        </section>
      )}

      {/* Strengthened */}
      {hasStrengthened && (
        <section>
          <div className="text-2xs font-semibold text-text-secondary uppercase tracking-wide mb-2">
            Strengthened ({digest.strengthenedThisPeriod.length})
          </div>
          <ul className="space-y-2">
            {digest.strengthenedThisPeriod.map((e) => (
              <DigestEntry
                key={e.key}
                concept={e.concept}
                stance={e.stance}
                projectCount={e.projectCount}
                reason={e.latestReason}
                strengthenedCount={e.newInstancesInPeriod}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border-default bg-surface-secondary px-3 py-2">
      <div className="text-lg font-bold text-text-primary leading-none">{value}</div>
      <div className="text-2xs text-text-muted mt-1">{label}</div>
    </div>
  );
}

function DigestEntry({
  concept, stance, projectCount, reason, strengthenedCount,
}: {
  concept: string;
  stance: string;
  projectCount: number;
  reason?: string;
  strengthenedCount?: number;
}) {
  const badge = stanceBadgeClasses(stance);
  return (
    <li className="rounded border border-border-default bg-surface-secondary p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-text-primary break-words">{concept}</div>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${badge}`}>
          {stance}
        </span>
      </div>
      <div className="mt-1 text-2xs text-text-muted flex gap-x-3">
        {projectCount > 1 && <span>{projectCount} projects</span>}
        {strengthenedCount !== undefined && <span>+{strengthenedCount} this period</span>}
      </div>
      {reason && <div className="mt-2 text-2xs text-text-secondary italic">"{reason}"</div>}
    </li>
  );
}

function stanceBadgeClasses(stance: string): string {
  if (stance === "avoid") return "bg-accent-red-dim text-accent-red";
  if (stance === "prefer") return "bg-accent-green-dim text-accent-green";
  return "bg-surface-hover text-text-secondary";
}

function FilterPill({
  active, onClick, label, tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone?: "red" | "green";
}) {
  const activeTone =
    tone === "red" ? "bg-accent-red-dim text-accent-red border-accent-red/30"
    : tone === "green" ? "bg-accent-green-dim text-accent-green border-accent-green/30"
    : "bg-accent-blue-dim text-accent-blue border-accent-blue/30";
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded text-2xs font-medium border transition-colors ${
        active ? activeTone
          : "bg-surface-secondary text-text-secondary border-border-default hover:bg-surface-hover"
      }`}
    >
      {label}
    </button>
  );
}

function EntryRow({ entry }: { entry: PhilosophyEntry }) {
  const stanceBadge =
    entry.stance === "avoid"
      ? { label: "avoid", cls: "bg-accent-red-dim text-accent-red" }
      : entry.stance === "prefer"
      ? { label: "prefer", cls: "bg-accent-green-dim text-accent-green" }
      : { label: "mixed", cls: "bg-surface-hover text-text-secondary" };

  return (
    <li className="rounded border border-border-default bg-surface-secondary p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-text-primary break-words">
          {entry.concept}
        </div>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${stanceBadge.cls}`}>
          {stanceBadge.label}
        </span>
      </div>
      <div className="mt-1 text-2xs text-text-muted flex flex-wrap gap-x-3 gap-y-0.5">
        {entry.projectCount > 1 && <span>{entry.projectCount} projects</span>}
        <span>{entry.rejected} rejected</span>
        <span>{entry.approved} approved</span>
      </div>
      {entry.latestReason && (
        <div className="mt-2 text-2xs text-text-secondary italic leading-relaxed">
          "{entry.latestReason}"
        </div>
      )}
    </li>
  );
}
