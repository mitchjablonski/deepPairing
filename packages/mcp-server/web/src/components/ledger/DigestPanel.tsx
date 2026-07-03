import { StatTile } from "./LedgerPanel";
import type { DigestData } from "./types";

export function DigestPanel({ digest, error }: { digest: DigestData | null; error: string | null }) {
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
