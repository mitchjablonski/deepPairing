import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useArtifactStore } from "../stores/artifact";
import { useLedgerStore, ensureLedgerSubscriptions } from "../stores/ledger";

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

interface TeamPreference {
  id: string;
  kind: "require" | "prefer" | "avoid";
  concept: string;
  rationale: string;
  scope?: { paths?: string[] };
  addedBy?: string;
  addedAt?: string;
}

interface TeamPreferencesData {
  preferences: TeamPreference[];
  exists: boolean;
}

type Filter = "all" | "avoid" | "prefer" | "mixed";
// AA5 — "ledger" tab is the cross-project moat surface unlocked by Z1's
// durable preflight traces. Aggregates how many proposals the ledger has
// shaped IN this project + cross-project totals, with top cited stances.
type Tab = "stances" | "ledger" | "digest" | "team";

export interface LedgerDigest {
  shapedThisProject: number;
  nearMissesThisProject: number;
  blockedThisProject: number;
  sessionsTouched: number;
  topCitedStances: Array<{
    concept: string;
    source: "session" | "team";
    citationCount: number;
    /**
     * EE3 — cross-project citation count for the same concept (sum of
     * non-manual instances across the global ledger). Optional for
     * back-compat with pre-EE3 fixtures.
     */
    globalCitationCount?: number;
    sampleArtifactId?: string;
    sampleSessionId?: string;
  }>;
  // DD1 — UI-side counterpart to CC8. Pre-DD1 the agent saw seeded
  // stances by name via recall(mode='ledger') but the human only saw
  // an aggregate "N concepts" tile and an empty cited-list — read as
  // broken on cold start. seededStances mirrors the wire shape used
  // in tools/recall.ts so both surfaces tell the same story.
  seededStances?: Array<{
    concept: string;
    stance: "avoid" | "prefer" | "mixed";
    citedTimesElsewhere: number;
  }>;
  globalLedger: {
    concepts: number;
    projects: number;
    multiProjectConcepts: number;
  };
}

export function YourTasteDrawer({
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
  const panelRef = useRef<HTMLDivElement>(null);
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
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`http://${window.location.host}/api/team-preferences`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setTeamPrefs(data);
      } catch (err: any) {
        if (!cancelled) setTeamError(err?.message ?? String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [tab, teamPrefs, teamError]);

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
        <div className="px-5 pt-3 border-b border-border-default flex gap-1">
          <TabButton active={tab === "stances"} onClick={() => setTab("stances")} label="Stances" />
          {/* AA5 — Ledger tab is the cross-project moat surface. Always
              visible (unlike the gated Digest tab) because the value
              shows up from session #1 once Z1's traces exist. */}
          <TabButton active={tab === "ledger"} onClick={() => setTab("ledger")} label="Ledger" />
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
                    fetch(`http://${window.location.host}/api/philosophy?limit=200`)
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

/**
 * AA5 — Ledger panel. The cross-project moat surface that Z1's durable
 * preflight traces unlocked. Lives next to the Stances list because it's
 * the *consumption* view of the same data — Stances answers "what
 * positions do I hold?", Ledger answers "did those positions actually
 * matter to anything?". Without this surface, the moat is silent: users
 * accumulated stances but never saw their compounding effect.
 *
 * Empty state explicitly invites the user to build the ledger via normal
 * pairing rather than presupposing taste with a pre-seeded list (PMF
 * council deep dive rejected the bootstrap-by-onboarding path).
 */
// BB7 — exported so IdleHome can render the same digest in the cold-start
// home view (the moat is the screen the user sees, not a feature behind a
// drawer button).
export function LedgerPanel({
  data,
  error,
  onJumpToArtifact,
  highlightConcept,
}: {
  data: LedgerDigest | null;
  error: string | null;
  onJumpToArtifact?: (artifactId: string) => void;
  highlightConcept?: string;
}) {
  const highlightRef = useRef<HTMLLIElement>(null);
  // BB6 — scroll the highlighted row into view when the panel opens via
  // a PreflightBreadcrumb deep-link. Optional chain on scrollIntoView for
  // jsdom (per CLAUDE.md convention).
  useEffect(() => {
    if (highlightRef.current) highlightRef.current.scrollIntoView?.({ block: "center" });
  }, [highlightConcept, data]);
  if (error) {
    return (
      <div className="p-5 text-xs text-accent-red">
        Could not load the ledger: {error}
      </div>
    );
  }
  if (!data) {
    return <div className="p-5 text-xs text-text-muted">Loading…</div>;
  }
  const { shapedThisProject, nearMissesThisProject, blockedThisProject, sessionsTouched, topCitedStances, globalLedger } = data;
  const seededStances = data.seededStances ?? [];
  // DD1 — empty test still requires no seeds either, so a fresh project
  // with one paste doesn't show the bootstrap copy underneath the seeded
  // section.
  const empty = shapedThisProject === 0 && globalLedger.concepts === 0 && seededStances.length === 0;
  // CC2 — when the user deep-linked into the ledger from a PreflightBreadcrumb
  // concept, the matching row may not be in topCitedStances (the digest caps
  // at the top 10 by citation count, so a concept that fired once is invisible
  // in the list). Pre-CC2 the click registered, the drawer opened, but
  // nothing was highlighted — read as broken. Now we render an inline
  // acknowledgement row above the list explaining the situation.
  const highlightInList =
    highlightConcept && topCitedStances.some((s) => s.concept === highlightConcept);
  const highlightOrphan = highlightConcept && !highlightInList;

  return (
    <div className="p-5 space-y-5">
      {/* Headline — the project + global numbers side by side. The
          project number quantifies "the moat helped THIS work"; the
          global number quantifies "the moat is bigger than THIS work". */}
      <div className="grid grid-cols-2 gap-2">
        <StatTile label="proposals shaped here" value={shapedThisProject} />
        <StatTile label="cross-project stances" value={globalLedger.concepts} />
      </div>
      {(nearMissesThisProject > 0 || blockedThisProject > 0) && (
        <div className="grid grid-cols-2 gap-2">
          {nearMissesThisProject > 0 && (
            <StatTile label="near-misses caught" value={nearMissesThisProject} />
          )}
          {blockedThisProject > 0 && (
            <StatTile label="proposals blocked" value={blockedThisProject} />
          )}
        </div>
      )}
      <div className="text-2xs text-text-muted">
        {sessionsTouched > 0
          ? `${sessionsTouched} session${sessionsTouched === 1 ? "" : "s"} in this project · ${globalLedger.projects} project${globalLedger.projects === 1 ? "" : "s"} total`
          : "No preflight traces in this project yet."}
        {globalLedger.multiProjectConcepts > 0 && (
          <> · <span className="text-accent-violet">{globalLedger.multiProjectConcepts} stances span multiple projects</span></>
        )}
      </div>

      {/* Empty state — same framing as the breadcrumb's bootstrap copy
          (PMF council Y3 amendment): tell the user where the data will
          come from, don't presuppose what should be in it. */}
      {empty && (
        <div className="text-xs text-text-muted leading-relaxed border border-accent-violet/15 bg-accent-violet-dim/10 rounded p-3">
          <p className="mb-2 font-medium text-text-secondary">Your ledger is empty.</p>
          <p>
            Reject something the agent proposes — or add reasoning to a pick — and
            future proposals get cross-checked against it. After a few sessions,
            this view shows which of your stances kept catching things, and which
            spanned multiple projects.
          </p>
        </div>
      )}

      {/* CC2 — orphan-highlight banner. The user clicked a "Considered:"
          concept in a PreflightBreadcrumb that was consulted once and
          isn't yet in the top-cited stances. Without this banner, the
          drawer opens to a list that doesn't contain the concept and
          the click feels broken.
          DD8 — make the threshold concrete. Pre-DD8 the copy ("it'll
          show here once it accumulates more citations") implied a vague
          future appearance; users had no model for "how many" or
          "when". Now we read the bottom-of-list count and tell them
          the actual threshold. */}
      {highlightOrphan && (
        <div
          data-testid="ledger-orphan-banner"
          className="text-2xs text-text-secondary leading-relaxed border border-accent-violet/30 bg-accent-violet-dim/10 rounded px-3 py-2"
        >
          <span className="font-mono text-accent-violet">"{highlightConcept}"</span>
          {topCitedStances.length === 0
            ? " was consulted on this proposal but you haven't accumulated any cited stances yet — it'll appear in the list as soon as one fires."
            : ` was consulted on this proposal but isn't in the top ${topCitedStances.length} cited stances yet — it'll appear here once it's been cited more than the current bottom entry (cited ${topCitedStances[topCitedStances.length - 1].citationCount}×).`}
        </div>
      )}

      {/* DD1 — seeded stances, surfaced separately from cited stances.
          Pre-DD1 a user who pasted 5 rules into the SeedAffordance saw
          the cited list stay empty until the agent fired one of them —
          read as "the seed didn't take." Now the panel acknowledges the
          seeds explicitly. citedTimesElsewhere shows when an inbound
          real-session citation also happened to match the seed. */}
      {seededStances.length > 0 && (
        <section data-testid="ledger-seeded-section">
          <div className="text-2xs font-semibold text-text-secondary uppercase tracking-wide mb-2 flex items-center gap-2">
            <span>Seeded by you</span>
            <span className="text-text-muted normal-case font-normal">
              ({seededStances.length})
            </span>
          </div>
          <p className="text-2xs text-text-muted mb-2">
            Fires when the agent proposes something that matches.
          </p>
          <ul className="space-y-2">
            {seededStances.slice(0, 12).map((s) => {
              const stanceTone =
                s.stance === "avoid"
                  ? "bg-accent-red-dim/40 text-accent-red"
                  : s.stance === "prefer"
                    ? "bg-accent-green-dim/40 text-accent-green"
                    : "bg-surface-elevated text-text-muted";
              return (
                <li
                  key={`seed:${s.concept}`}
                  className="rounded border border-accent-violet/20 bg-accent-violet-dim/5 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-mono text-xs text-text-primary break-words">{s.concept}</div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span
                        className="px-1 py-px rounded text-[10px] uppercase tracking-wide bg-accent-violet-dim/40 text-accent-violet"
                        title="Manually seeded by you (not yet earned through a session)"
                      >
                        SEED
                      </span>
                      <span className={`px-1 py-px rounded text-[10px] uppercase tracking-wide ${stanceTone}`}>
                        {s.stance}
                      </span>
                      {s.citedTimesElsewhere > 0 && (
                        <span className="text-2xs font-semibold text-accent-violet" title="Times this seed has fired in real sessions">
                          fired {s.citedTimesElsewhere}×
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {seededStances.length > 12 && (
            <p className="text-2xs text-text-muted mt-1.5">
              … {seededStances.length - 12} more seeded stances.
            </p>
          )}
        </section>
      )}

      {/* Top stances by citation count. This is the moat made measurable —
          "stance X was consulted N times" is the most concrete answer to
          'why deepPairing vs Cursor 3' that this UI can deliver. */}
      {topCitedStances.length > 0 && (
        <section>
          <div className="text-2xs font-semibold text-text-secondary uppercase tracking-wide mb-2">
            Top cited stances
          </div>
          <ul className="space-y-2">
            {topCitedStances.slice(0, 10).map((s) => {
              // BB6 — clickable row when we know which artifact cited the
              // stance. Without sampleArtifactId, fall back to a plain row
              // (no jump target — happens for stances cited only in
              // sessions whose digest didn't capture the sample).
              const canJump = Boolean(s.sampleArtifactId && onJumpToArtifact);
              const inner = (
                <div className="flex items-start justify-between gap-2">
                  <div className="font-mono text-xs text-text-primary break-words">{s.concept}</div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span
                      className={`px-1 py-px rounded text-[10px] uppercase tracking-wide ${
                        s.source === "team"
                          ? "bg-accent-blue-dim/40 text-accent-blue"
                          : "bg-surface-elevated text-text-muted"
                      }`}
                      title={s.source === "team" ? "From .deeppairing/team.json" : "From your sessions"}
                    >
                      {s.source}
                    </span>
                    <span className="text-2xs font-semibold text-accent-violet">
                      {s.citationCount}×
                    </span>
                  </div>
                </div>
              );
              const isHighlighted = highlightConcept === s.concept;
              const ringClass = isHighlighted ? "ring-2 ring-accent-violet" : "";
              if (canJump) {
                return (
                  <li
                    key={`${s.source}:${s.concept}`}
                    ref={isHighlighted ? highlightRef : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => onJumpToArtifact!(s.sampleArtifactId!)}
                      className={`block w-full text-left rounded border border-border-default bg-surface-secondary p-3 hover:border-accent-violet/40 hover:bg-surface-elevated transition-colors ${ringClass}`}
                      title={`Jump to a citing artifact (${s.sampleArtifactId})`}
                    >
                      {inner}
                    </button>
                  </li>
                );
              }
              return (
                <li
                  key={`${s.source}:${s.concept}`}
                  ref={isHighlighted ? highlightRef : undefined}
                  className={`rounded border border-border-default bg-surface-secondary p-3 ${ringClass}`}
                >
                  {inner}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * AA9 — opt-in ledger seed. The PMF council's deep-dive resolution to
 * the empty-ledger silent killer.
 *
 * Two failed framings the dive rejected:
 *   - Pre-seeded stance picks ("I prefer composition over inheritance")
 *     — opinionated, presupposes user taste, brand suicide for a tool
 *     whose pitch is "your taste, accumulated."
 *   - Bootstrap-by-instruction in the breadcrumb ("Reject something —
 *     or add reasoning to a pick") — reads as a tooltip; the user has
 *     to wait for the agent to propose something they DON'T want
 *     before any signal lands.
 *
 * This is the third path: paste-a-rule. The user supplies one or more
 * lines they've already written down (CLAUDE.md, code-review template,
 * team doc) and pick whether each is something to PREFER or AVOID.
 * The text becomes a recordInstance call with synthetic project="manual"
 * + sessionId="seed" so the manually-seeded entries are distinguishable
 * from session-driven ones in any future filtering view.
 *
 * Lives ONLY in the drawer's empty state — once the ledger has any
 * entries, the affordance disappears. The user can still seed more via
 * the obvious "Add" button we'll add in a future phase if there's
 * pull, but the empty-state placement is the one anti-cold-start
 * lever.
 */
// BB7 — exported so the cold-start IdleHome can render this affordance
// inline below the ledger digest. AA9's spec called the seed affordance
// the answer to the empty-ledger silent killer; placing it on the home
// screen instead of behind the YourTaste drawer button is what makes
// "paste a rule" the obvious cold-start action.
export function SeedAffordance({ onSeeded }: { onSeeded: () => void }) {
  const [text, setText] = useState("");
  const [verdict, setVerdict] = useState<"approved" | "rejected">("approved");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const concept = text.trim();
    if (!concept || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`http://${window.location.host}/api/philosophy/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept, verdict }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `seed failed (${res.status})`);
      }
      setText("");
      onSeeded();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded border border-accent-violet/20 bg-accent-violet-dim/15 p-4">
      <div className="text-2xs font-semibold text-accent-violet uppercase tracking-wide mb-2">
        Seed your ledger
      </div>
      <p className="text-2xs text-text-muted leading-relaxed mb-3">
        Paste a rule from your CLAUDE.md, code-review checklist, or team doc — anything
        you've already written down about how you like code. Each line becomes a stance
        the agent's preflight will check against on every proposal.
      </p>
      <p className="text-2xs text-text-muted/80 leading-relaxed mb-2 italic">
        One rule per line — short concept names match best (e.g. "global mutable state",
        not "avoid global mutable state because…").
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"global mutable state\nbcrypt rounds < 12\ninline SQL strings\nsynchronous fs in request handlers"}
        rows={4}
        disabled={submitting}
        className="w-full px-3 py-2 bg-surface-secondary border border-border-default rounded text-xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none"
      />
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        <div role="radiogroup" aria-label="Stance" className="flex items-center gap-1">
          <VerdictPill active={verdict === "approved"} onClick={() => setVerdict("approved")} label="Prefer" tone="green" />
          <VerdictPill active={verdict === "rejected"} onClick={() => setVerdict("rejected")} label="Avoid" tone="red" />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim() || submitting}
          className="ml-auto px-3 py-1 rounded text-2xs font-medium bg-accent-violet text-white hover:bg-accent-violet/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "Seeding…" : "Add to ledger"}
        </button>
      </div>
      {error && (
        <div className="mt-2 text-2xs text-accent-red">Could not seed: {error}</div>
      )}
    </div>
  );
}

function VerdictPill({ active, onClick, label, tone }: { active: boolean; onClick: () => void; label: string; tone: "green" | "red" }) {
  const activeBg = tone === "green" ? "bg-accent-green-dim text-accent-green" : "bg-accent-red-dim text-accent-red";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-2xs ${active ? activeBg : "text-text-muted hover:text-text-secondary"}`}
    >
      {label}
    </button>
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

/**
 * P3 — Team conventions panel. Read-only view of .deeppairing/team.json.
 * Nudges `npx deeppairing team init` when the file is absent or empty.
 * Edits happen via file + PR (intentional — team policy isn't something
 * you change from a chat UI).
 */
function TeamPanel({ data, error }: { data: TeamPreferencesData | null; error: string | null }) {
  if (error) {
    return (
      <div className="p-5 text-xs text-accent-red">
        Could not load team preferences: {error}
      </div>
    );
  }
  if (!data) {
    return <div className="p-5 text-xs text-text-muted">Loading…</div>;
  }
  if (!data.exists || data.preferences.length === 0) {
    return (
      <div className="p-5 text-xs text-text-muted leading-relaxed space-y-3">
        <p className="font-medium text-text-secondary">No team conventions set up yet.</p>
        <p>
          Team conventions live at <code className="text-[11px] bg-surface-elevated px-1 py-0.5 rounded">.deeppairing/team.json</code> — a
          committable file your whole team's deepPairing sessions will pick up. Scaffold one with:
        </p>
        <pre className="text-[11px] bg-surface-elevated px-3 py-2 rounded border border-border-default overflow-x-auto">
          npx deeppairing team init
        </pre>
        <p className="leading-relaxed">
          Each preference carries a <strong>kind</strong> (require / prefer / avoid),
          a <strong>concept</strong> in plain English, a <strong>rationale</strong>,
          and optional path scope. Pre-flight validation uses avoid / require
          to refuse conflicting proposals; prefer is taste.
        </p>
      </div>
    );
  }

  const groups: Array<["require" | "avoid" | "prefer", string, TeamPreference[]]> = [
    ["require", "Required", data.preferences.filter((p) => p.kind === "require")],
    ["avoid", "Avoid", data.preferences.filter((p) => p.kind === "avoid")],
    ["prefer", "Preferred", data.preferences.filter((p) => p.kind === "prefer")],
  ];

  return (
    <div className="p-5 space-y-5">
      <div className="text-2xs text-text-muted leading-relaxed">
        Read-only here — edit <code className="text-[11px] bg-surface-elevated px-1 py-0.5 rounded">.deeppairing/team.json</code> and commit.
      </div>
      {groups.map(([kind, label, prefs]) => {
        if (prefs.length === 0) return null;
        return (
          <section key={kind}>
            <div className="text-2xs font-semibold text-text-secondary uppercase tracking-wide mb-2">
              {label} ({prefs.length})
            </div>
            <ul className="space-y-2.5">
              {prefs.map((p) => (
                <TeamPrefRow key={p.id} pref={p} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function TeamPrefRow({ pref }: { pref: TeamPreference }) {
  const badge =
    pref.kind === "require" ? "bg-accent-red-dim text-accent-red"
    : pref.kind === "avoid" ? "bg-accent-red-dim text-accent-red"
    : "bg-accent-green-dim text-accent-green";

  return (
    <li className="rounded border border-border-default bg-surface-secondary p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-text-primary break-words">{pref.concept}</div>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${badge}`}>
          {pref.kind}
        </span>
      </div>
      <div className="mt-1 text-2xs text-text-secondary leading-relaxed">
        {pref.rationale}
      </div>
      {(pref.scope?.paths?.length || pref.addedBy) && (
        <div className="mt-1.5 text-[10px] text-text-muted flex gap-x-3 flex-wrap">
          {pref.scope?.paths?.length && (
            <span>scope: {pref.scope.paths.join(", ")}</span>
          )}
          {pref.addedBy && <span>added by {pref.addedBy}</span>}
        </div>
      )}
    </li>
  );
}
