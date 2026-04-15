import { useMemo } from "react";
import { useArtifactStore } from "../stores/artifact";

export function SessionMetrics() {
  const { artifacts, comments } = useArtifactStore();

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
    <div className="flex items-center gap-3 px-3 py-1 border-t border-border-default bg-surface-secondary text-2xs text-text-muted">
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
    </div>
  );
}
