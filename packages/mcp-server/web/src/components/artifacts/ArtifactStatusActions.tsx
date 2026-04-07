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

  // Already resolved
  if (artifact.status === "approved") {
    return (
      <div className="flex items-center gap-2 pt-2 border-t border-border-default">
        <span className="text-green-600 text-sm">&#10003;</span>
        <span className="text-xs text-green-700 font-medium">Approved</span>
      </div>
    );
  }

  if (artifact.status === "rejected") {
    return (
      <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
        <span className="text-red-600 text-sm">&#10007;</span>
        <span className="text-xs text-red-700 font-medium">Rejected</span>
      </div>
    );
  }

  if (artifact.status === "superseded") {
    return (
      <div className="pt-2 border-t border-gray-100">
        <span className="text-xs text-gray-400 italic">Superseded by newer version</span>
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
    <div className="pt-3 border-t border-gray-100 space-y-2">
      {!showRevisionInput ? (
        <div className="flex gap-2">
          <button
            onClick={() => handleAction("approved")}
            disabled={submitting}
            className="px-3 py-1.5 bg-green-600 text-white text-xs font-medium rounded
                       hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            Approve
          </button>
          <button
            onClick={() => setShowRevisionInput(true)}
            disabled={submitting}
            className="px-3 py-1.5 bg-amber-100 text-amber-700 text-xs font-medium rounded
                       hover:bg-amber-200 disabled:opacity-50 transition-colors"
          >
            Request Revision
          </button>
          <button
            onClick={() => handleAction("rejected")}
            disabled={submitting}
            className="px-3 py-1.5 bg-red-100 text-red-700 text-xs font-medium rounded
                       hover:bg-red-200 disabled:opacity-50 transition-colors"
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
            className="w-full px-3 py-2 border border-amber-300 rounded-md text-xs resize-none
                       focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
          <div className="flex gap-2">
            <button
              onClick={() => handleAction("revised", feedback)}
              disabled={!feedback.trim() || submitting}
              className="px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded
                         hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              Submit Revision Request
            </button>
            <button
              onClick={() => { setShowRevisionInput(false); setFeedback(""); }}
              className="px-3 py-1.5 text-gray-500 text-xs hover:text-gray-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
