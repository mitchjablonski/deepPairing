import { useState } from "react";
import { useArtifactStore } from "../stores/artifact";

export function ReviewGate() {
  const { artifacts, updateArtifactStatus, resolveDecision } = useArtifactStore();
  const [confirming, setConfirming] = useState(false);

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

  // Build summary of what Accept All will do
  const autoDecisions = decisionDraft.map((a) => {
    const options = (a.content as any)?.options ?? [];
    const recommended = options.find((o: any) => o.recommendation) ?? options[0];
    return { artifact: a, recommended };
  }).filter((d) => d.recommended);

  const handleAcceptAll = async () => {
    if (decisionDraft.length > 0 && !confirming) {
      setConfirming(true);
      return;
    }

    for (const artifact of allDraft) {
      if (artifact.type === "decision") {
        const options = (artifact.content as any)?.options ?? [];
        const recommended = options.find((o: any) => o.recommendation) ?? options[0];
        const decisionId = (artifact.content as any)?.decisionId;
        if (recommended && decisionId) {
          await resolveDecision(decisionId, recommended.id, "Accepted via bulk approve");
        }
      }
      await updateArtifactStatus(artifact.id, "approved");
    }
    setConfirming(false);
  };

  // Build description
  const parts: string[] = [];
  if (reviewDraft.length > 0) parts.push(`${reviewDraft.length} finding${reviewDraft.length > 1 ? "s" : ""}`);
  if (decisionDraft.length > 0) parts.push(`${decisionDraft.length} decision${decisionDraft.length > 1 ? "s" : ""}`);
  if (planDraft.length > 0) parts.push(`${planDraft.length} plan${planDraft.length > 1 ? "s" : ""}`);

  return (
    <div className="px-3 py-2 bg-accent-green-dim/30 border-b border-accent-green/15 space-y-1.5">
      <div className="flex items-center justify-between gap-3">
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
            className={`px-2.5 py-1 text-2xs font-medium rounded transition-colors ${
              confirming
                ? "bg-accent-amber text-text-inverse hover:bg-accent-amber/80"
                : "bg-accent-green text-text-inverse hover:bg-accent-green/80"
            }`}
          >
            {confirming ? "Confirm — Accept All" : "Accept All & Proceed"}
          </button>
          {confirming && (
            <button
              onClick={() => setConfirming(false)}
              className="text-2xs text-text-muted hover:text-text-secondary"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Confirmation: show which decisions will be auto-resolved */}
      {confirming && autoDecisions.length > 0 && (
        <div className="text-2xs text-accent-amber bg-accent-amber-dim/30 rounded px-2 py-1.5">
          Will auto-select recommended options:
          {autoDecisions.map((d) => (
            <span key={d.artifact.id} className="block ml-2 text-text-secondary">
              • {(d.artifact.content as any)?.context}: <strong>{d.recommended?.title}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
