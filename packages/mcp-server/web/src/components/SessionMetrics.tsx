import { useEffect, useMemo, useState } from "react";
import { apiGet, apiBase } from "../lib/api";
import { useArtifactStore } from "../stores/artifact";

/** R1: cumulative metrics from /api/metrics — proves the moat is compounding. */
interface MetricsSnapshot {
  firstSeenAt: string;
  sessions: number;
  counts: {
    preflightBlocks: { total: number; bySource: { session: number; team: number } };
    ledgerWrites: { total: number; rejected: number; approved: number };
    retrospectives: { total: number; right: number; wrong: number; mixed: number };
    horizonChecksRequested: number;
    questions: { asked: number; answered: number };
    artifacts?: { total: number; byType: Record<string, number> };
    visuals?: { total: number; byKind: Record<string, number> };
    comments?: number;
  };
}

/** Compact "plan 3 · spec 1" detail from a by-key count record. */
function recordDetail(rec?: Record<string, number>): string | undefined {
  if (!rec) return undefined;
  const entries = Object.entries(rec).filter(([, n]) => n > 0);
  if (entries.length === 0) return undefined;
  return entries.map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(" · ");
}

export function SessionMetrics() {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const comments = useArtifactStore((s) => s.comments);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);

  // R1: cumulative counts across every session in this project (the moat).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet(`${apiBase()}/api/metrics`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setMetrics(data);
      } catch {
        // Silent — section just hides if the endpoint isn't reachable
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const stats = useMemo(() => {
    const byType = {
      research: artifacts.filter((a) => a.type === "research").length,
      decision: artifacts.filter((a) => a.type === "decision").length,
      plan: artifacts.filter((a) => a.type === "plan").length,
      code_change: artifacts.filter((a) => a.type === "code_change").length,
    };

    // Flatten all comments
    const allComments = Object.values(comments).flat();
    const humanComments = allComments.filter((c) => c.author === "human").length;
    const approvals = artifacts.filter((a) => a.status === "approved").length;
    const rejections = artifacts.filter((a) => a.status === "rejected").length;

    // Session duration
    const timestamps = artifacts.map((a) => new Date(a.createdAt).getTime());
    let duration = "";
    if (timestamps.length >= 2) {
      const ms = Math.max(...timestamps) - Math.min(...timestamps);
      const mins = Math.floor(ms / 60000);
      if (mins < 60) {
        duration = `${mins}m`;
      } else {
        const hours = Math.floor(mins / 60);
        const remainMins = mins % 60;
        duration = `${hours}h ${remainMins}m`;
      }
    }

    // Approval rate
    const reviewed = artifacts.filter((a) => a.status !== "draft" && a.status !== "superseded").length;
    const approvalRate = reviewed > 0 ? Math.round((approvals / reviewed) * 100) : null;

    return { byType, humanComments, approvals, rejections, duration, approvalRate };
  }, [artifacts, comments]);

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-1 border-t border-border-default bg-surface-secondary text-2xs text-text-muted">
      <div className="flex items-center gap-2">
        {stats.byType.research > 0 && (
          <span>Findings: <strong className="text-text-secondary">{stats.byType.research}</strong></span>
        )}
        {stats.byType.decision > 0 && (
          <span>Decisions: <strong className="text-text-secondary">{stats.byType.decision}</strong></span>
        )}
        {stats.byType.plan > 0 && (
          <span>Plans: <strong className="text-text-secondary">{stats.byType.plan}</strong></span>
        )}
        {stats.byType.code_change > 0 && (
          <span>Changes: <strong className="text-text-secondary">{stats.byType.code_change}</strong></span>
        )}
      </div>

      <span className="text-border-default">|</span>

      <div className="flex items-center gap-2">
        {stats.humanComments > 0 && (
          <span>Comments: <strong className="text-text-secondary">{stats.humanComments}</strong></span>
        )}
        {stats.approvals > 0 && (
          <span className="text-accent-green">Approved: {stats.approvals}</span>
        )}
        {stats.rejections > 0 && (
          <span className="text-accent-red">Rejected: {stats.rejections}</span>
        )}
      </div>

      {stats.approvalRate != null && (
        <>
          <span className="text-border-default">|</span>
          <span>Accept rate: <strong className="text-text-secondary">{stats.approvalRate}%</strong></span>
        </>
      )}

      {stats.duration && (
        <>
          <span className="text-border-default">|</span>
          <span>{stats.duration}</span>
        </>
      )}

      {/* R1: cumulative across every session in this project. Hidden
          until metrics.json has accumulated signal — a blank grid on
          day one sells nothing. */}
      {metrics && metrics.sessions > 0 && (
        <div className="w-full pt-2 mt-2 border-t border-border-default space-y-2">
          <div className="text-2xs font-semibold text-text-secondary uppercase tracking-wide">
            Across all sessions in this project
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs">
            <MetricRow label="Sessions" value={metrics.sessions} />
            <MetricRow
              label="🛡 Pre-flight blocks"
              value={metrics.counts.preflightBlocks.total}
              detail={
                metrics.counts.preflightBlocks.total > 0
                  ? `${metrics.counts.preflightBlocks.bySource.session} you · ${metrics.counts.preflightBlocks.bySource.team} team`
                  : undefined
              }
            />
            <MetricRow
              label="🧭 Ledger writes"
              value={metrics.counts.ledgerWrites.total}
              detail={
                metrics.counts.ledgerWrites.total > 0
                  ? `${metrics.counts.ledgerWrites.rejected} avoid · ${metrics.counts.ledgerWrites.approved} prefer`
                  : undefined
              }
            />
            <MetricRow
              label="Retrospectives"
              value={metrics.counts.retrospectives.total}
              detail={
                metrics.counts.retrospectives.total > 0
                  ? `${metrics.counts.retrospectives.right} right · ${metrics.counts.retrospectives.wrong} wrong · ${metrics.counts.retrospectives.mixed} mixed`
                  : undefined
              }
            />
            <MetricRow label="Horizon checks" value={metrics.counts.horizonChecksRequested} />
            <MetricRow
              label="❓ Questions"
              value={metrics.counts.questions.asked}
              detail={
                metrics.counts.questions.asked > 0
                  ? `${metrics.counts.questions.answered} answered`
                  : undefined
              }
            />
            <MetricRow
              label="📦 Artifacts produced"
              value={metrics.counts.artifacts?.total ?? 0}
              detail={recordDetail(metrics.counts.artifacts?.byType)}
            />
            <MetricRow
              label="🖼 Visuals attached"
              value={metrics.counts.visuals?.total ?? 0}
              detail={recordDetail(metrics.counts.visuals?.byKind)}
            />
            <MetricRow label="💬 Comments (you)" value={metrics.counts.comments ?? 0} />
          </div>
        </div>
      )}
    </div>
  );
}

function MetricRow({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-text-muted">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <strong className="text-text-primary font-mono">{value}</strong>
        {detail && <span className="text-[10px] text-text-muted">{detail}</span>}
      </span>
    </div>
  );
}
