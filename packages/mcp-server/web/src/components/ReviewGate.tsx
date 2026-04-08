import { useArtifactStore } from "../stores/artifact";

/**
 * Shows when there are draft artifacts awaiting review.
 * Two actions:
 * - "Reviewed — Proceed": approves all draft research/reasoning artifacts
 * - "Accept All & Proceed": approves ALL draft artifacts including decisions/plans
 *
 * This is the phase gate — the agent won't proceed until the human signals readiness.
 */
export function ReviewGate() {
  const { artifacts, updateArtifactStatus, resolveDecision } = useArtifactStore();

  const allDraft = artifacts.filter((a) => a.status === "draft");
  const reviewDraft = allDraft.filter((a) => ["research", "reasoning"].includes(a.type));
  const decisionDraft = allDraft.filter((a) => a.type === "decision");
  const planDraft = allDraft.filter((a) => a.type === "plan");

  if (allDraft.length === 0) return null;

  const handleReviewedProceed = async () => {
    for (const artifact of reviewDraft) {
      await updateArtifactStatus(artifact.id, "approved");
    }
  };

  const handleAcceptAll = async () => {
    for (const artifact of allDraft) {
      if (artifact.type === "decision") {
        // Auto-select the recommended option
        const options = (artifact.content as any)?.options ?? [];
        const recommended = options.find((o: any) => o.recommendation) ?? options[0];
        const decisionId = (artifact.content as any)?.decisionId;
        if (recommended && decisionId) {
          await resolveDecision(decisionId, recommended.id, "Accepted via bulk approve");
        }
      }
      await updateArtifactStatus(artifact.id, "approved");
    }
  };

  // Build description
  const parts: string[] = [];
  if (reviewDraft.length > 0) parts.push(`${reviewDraft.length} finding${reviewDraft.length > 1 ? "s" : ""}`);
  if (decisionDraft.length > 0) parts.push(`${decisionDraft.length} decision${decisionDraft.length > 1 ? "s" : ""}`);
  if (planDraft.length > 0) parts.push(`${planDraft.length} plan${planDraft.length > 1 ? "s" : ""}`);

  return (
    <div className="px-3 py-2 bg-accent-green-dim/30 border-b border-accent-green/15 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full bg-accent-green shrink-0" />
        <span className="text-2xs text-text-secondary truncate">
          {parts.join(", ")} awaiting review
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {reviewDraft.length > 0 && reviewDraft.length < allDraft.length && (
          <button
            onClick={handleReviewedProceed}
            className="px-2.5 py-1 bg-surface-elevated text-text-secondary text-2xs font-medium rounded
                       border border-border-default hover:bg-surface-hover transition-colors"
          >
            Approve findings
          </button>
        )}
        <button
          onClick={handleAcceptAll}
          className="px-2.5 py-1 bg-accent-green text-text-inverse text-2xs font-medium rounded
                     hover:bg-accent-green/80 transition-colors"
        >
          Accept All & Proceed
        </button>
      </div>
    </div>
  );
}
