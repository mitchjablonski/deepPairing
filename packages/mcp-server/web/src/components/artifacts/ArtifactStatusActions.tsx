import { useState } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";

interface ArtifactStatusActionsProps {
  artifact: Artifact;
}

export function ArtifactStatusActions({ artifact }: ArtifactStatusActionsProps) {
  const [showRevisionInput, setShowRevisionInput] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { updateArtifactStatus } = useArtifactStore();

  if (artifact.status === "approved") {
    return (
      <div className="flex items-center gap-2 pt-2 border-t border-border-default">
        <span className="text-accent-green text-sm">&#10003;</span>
        <span className="text-xs text-accent-green font-medium">Approved</span>
      </div>
    );
  }

  if (artifact.status === "rejected") {
    return (
      <div className="flex items-center gap-2 pt-2 border-t border-border-default">
        <span className="text-accent-red text-sm">&#10007;</span>
        <span className="text-xs text-accent-red font-medium">Rejected</span>
      </div>
    );
  }

  if (artifact.status === "superseded") {
    return (
      <div className="pt-2 border-t border-border-default">
        <span className="text-xs text-text-muted italic">Superseded by newer version</span>
      </div>
    );
  }

  const handleAction = async (
    action: "approved" | "revised" | "rejected",
    actionFeedback?: string,
  ) => {
    setSubmitting(true);
    await updateArtifactStatus(artifact.id, action, actionFeedback);
    setSubmitting(false);
    setShowRevisionInput(false);
    setFeedback("");
  };

  return (
    <div className="pt-3 border-t border-border-default space-y-2">
      {!showRevisionInput ? (
        <div className="flex gap-2">
          <button
            onClick={() => handleAction("approved")}
            disabled={submitting}
            className="px-3 py-1.5 bg-accent-green text-white text-xs font-medium rounded
                       hover:bg-accent-green/80 disabled:opacity-50 transition-colors"
          >
            Approve
          </button>
          <button
            onClick={() => setShowRevisionInput(true)}
            disabled={submitting}
            className="px-3 py-1.5 bg-accent-amber-dim text-accent-amber text-xs font-medium rounded
                       hover:bg-accent-amber-dim/80 disabled:opacity-50 transition-colors"
          >
            Request Revision
          </button>
          <button
            onClick={() => handleAction("rejected")}
            disabled={submitting}
            className="px-3 py-1.5 bg-accent-red-dim text-accent-red text-xs font-medium rounded
                       hover:bg-accent-red-dim/80 disabled:opacity-50 transition-colors"
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            placeholder="What should be changed?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 bg-surface-secondary border border-accent-amber/30 rounded text-xs text-text-primary resize-none
                       placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-amber"
          />
          <div className="flex gap-2">
            <button
              onClick={() => handleAction("revised", feedback)}
              disabled={!feedback.trim() || submitting}
              className="px-3 py-1.5 bg-accent-amber text-text-inverse text-xs font-medium rounded
                         hover:bg-accent-amber/80 disabled:opacity-50 transition-colors"
            >
              Submit Revision Request
            </button>
            <button
              onClick={() => { setShowRevisionInput(false); setFeedback(""); }}
              className="px-3 py-1.5 text-text-muted text-xs hover:text-text-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
