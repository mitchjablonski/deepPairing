import { useEffect, useRef, useState } from "react";
import { sessionHeaders, apiBase } from "../../lib/api";
import { useLedgerStore } from "../../stores/ledger";
import { normalizeConceptKey } from "@deeppairing/shared";
import type { LedgerDigest, PhilosophyEntry } from "./types";

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
  // B4 — case/whitespace-insensitive match (mirrors the server's normalizeKey
  // and the ConceptBadge lookup) so a deep-link with different casing still
  // finds its row; seeded rows count too (EE4 dedup removes their cited
  // duplicates, so pre-B4 a seeded concept never highlighted and the CC2
  // orphan banner fired with misleading copy).
  const conceptMatches = (a: string | undefined, b: string) =>
    !!a && normalizeConceptKey(a) === normalizeConceptKey(b);
  const highlightInList =
    highlightConcept &&
    (topCitedStances.some((s) => conceptMatches(highlightConcept, s.concept)) ||
      seededStances.some((s) => conceptMatches(highlightConcept, s.concept)));
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
              const inner = (
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
              );
              // FF1 — restore the BB6 jump-to-citing-artifact for seeded
              // rows that have a sample. EE4's dedup deleted the
              // duplicate top-cited row that previously carried this
              // affordance. Without this restoration, the seeded → real
              // citation causal-graph link was broken.
              const canJump = Boolean(s.sampleArtifactId && onJumpToArtifact);
              // B4 — seeded rows participate in the deep-link highlight (they
              // carry the stance pips ConceptBadge links from).
              const isSeedHighlighted = conceptMatches(highlightConcept, s.concept);
              const seedRing = isSeedHighlighted ? " ring-2 ring-accent-violet" : "";
              if (canJump) {
                return (
                  <li key={`seed:${s.concept}`} ref={isSeedHighlighted ? highlightRef : undefined}>
                    <button
                      type="button"
                      onClick={() => onJumpToArtifact!(s.sampleArtifactId!)}
                      className={`block w-full text-left rounded border border-accent-violet/20 bg-accent-violet-dim/5 p-3 hover:border-accent-violet/40 hover:bg-accent-violet-dim/15 transition-colors${seedRing}`}
                      title={`Jump to a citing artifact (${s.sampleArtifactId})`}
                    >
                      {inner}
                    </button>
                  </li>
                );
              }
              return (
                <li
                  key={`seed:${s.concept}`}
                  ref={isSeedHighlighted ? highlightRef : undefined}
                  className={`rounded border border-accent-violet/20 bg-accent-violet-dim/5 p-3${seedRing}`}
                >
                  {inner}
                </li>
              );
            })}
          </ul>
          {seededStances.length > 12 && (
            <p className="text-2xs text-text-muted mt-1.5">
              … {seededStances.length - 12} more seeded stances.
            </p>
          )}
          {/* EE10 — post-cold-start seed affordance. Pre-EE10, after the
              user pasted their first rule both inline SeedAffordances
              disappeared (DD10 in IdleHome + the drawer's empty-state
              gating). Adding a 6th rule a week later required either
              wiping the ledger or hitting /api/philosophy/seed directly.
              Inline toggle keeps the path obvious without competing
              with the moat-headline framing. */}
          <SeedMoreInline />
        </section>
      )}

      {/* EE4 — dedup against the Seeded by you section above. Pre-EE4
          a seed cited in a real session of THIS project rendered TWICE:
          once in "Seeded by you (fired N×)" and once in "Top cited
          stances" with the same concept name and a session-source pill.
          The seeded section already shows the citation count via
          citedTimesElsewhere — keep the seeded entry as the canonical
          render, drop the duplicate from the cited list. */}
      {(() => {
        const seededConceptKeys = new Set(seededStances.map((s) => s.concept));
        const dedupedTopCited = topCitedStances.filter((s) => !seededConceptKeys.has(s.concept));
        if (dedupedTopCited.length === 0) return null;
        return (
        <section>
          <div className="text-2xs font-semibold text-text-secondary uppercase tracking-wide mb-2">
            Top cited stances
          </div>
          <ul className="space-y-2">
            {dedupedTopCited.slice(0, 10).map((s) => {
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
              const isHighlighted = conceptMatches(highlightConcept, s.concept);
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
        );
      })()}
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
/**
 * EE10 + FF7 — inline "Seed more" affordance at the bottom of the
 * LedgerPanel's "Seeded by you" section.
 *
 * Pre-EE10 the user could only paste rules during the empty-ledger
 * window; after the first seed, both inline SeedAffordance instances
 * disappeared (DD10 in IdleHome + drawer's empty-state gating) and
 * adding a 6th rule a week later required direct API access. EE10
 * fixed the access gap with a "+ Seed more" → "Cancel" toggle, but
 * ease-of-use council called the click model out as inconsistent
 * with the cold-start path (which renders SeedAffordance directly,
 * no toggle). FF7 drops the toggle: SeedAffordance always renders
 * inline under a slim "Seed more" label, matching cold-start. One
 * gesture for both paths.
 */

function SeedMoreInline() {
  const refetchLedger = useLedgerStore((s) => s.refetch);
  return (
    <div className="mt-3" data-testid="ledger-seed-more">
      <div className="text-2xs font-semibold text-text-secondary uppercase tracking-wide mb-2">
        Seed more
      </div>
      <SeedAffordance
        onSeeded={() => {
          // Refresh the digest so the new seeds appear immediately
          // in the "Seeded by you" section above.
          void refetchLedger();
        }}
      />
    </div>
  );
}

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
      const res = await fetch(`${apiBase()}/api/philosophy/seed`, {
        method: "POST",
        headers: sessionHeaders(),
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
          className="ml-auto px-3 py-1 rounded text-2xs font-medium bg-accent-violet-strong text-white hover:bg-accent-violet-strong-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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

export function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border-default bg-surface-secondary px-3 py-2">
      <div className="text-lg font-bold text-text-primary leading-none">{value}</div>
      <div className="text-2xs text-text-muted mt-1">{label}</div>
    </div>
  );
}

export function FilterPill({
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

export function EntryRow({ entry }: { entry: PhilosophyEntry }) {
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
