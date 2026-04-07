import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";

export function TurnIndicator() {
  const { artifacts } = useArtifactStore();
  const connected = useConnectionStore((s) => s.connected);

  if (!connected) return null;

  // Count artifacts awaiting human action
  const pendingDecisions = artifacts.filter(
    (a) => a.type === "decision" && a.status === "draft",
  );
  const pendingPlans = artifacts.filter(
    (a) => a.type === "plan" && a.status === "draft",
  );
  const pendingCount = pendingDecisions.length + pendingPlans.length;

  if (pendingCount === 0) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-surface-elevated text-text-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
        Agent's turn
      </div>
    );
  }

  const parts: string[] = [];
  if (pendingDecisions.length > 0) {
    parts.push(`${pendingDecisions.length} decision${pendingDecisions.length > 1 ? "s" : ""}`);
  }
  if (pendingPlans.length > 0) {
    parts.push(`${pendingPlans.length} plan${pendingPlans.length > 1 ? "s" : ""}`);
  }

  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-accent-amber-dim text-accent-amber">
      <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse" />
      Your turn — {parts.join(", ")} waiting
    </div>
  );
}
