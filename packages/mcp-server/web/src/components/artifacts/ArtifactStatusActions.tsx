import { useState, useEffect, useRef } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

interface ArtifactStatusActionsProps {
  artifact: Artifact;
}

const COUNTDOWN_SECONDS = 10;

export function ArtifactStatusActions({ artifact }: ArtifactStatusActionsProps) {
  const [showRevisionInput, setShowRevisionInput] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { updateArtifactStatus } = useArtifactStore();
  const autonomyLevel = useConnectionStore((s) => s.autonomyLevel);

  // Auto-proceed countdown state
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownPaused, setCountdownPaused] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Determine if auto-proceed should be active
  const confidence = (artifact.content as any)?.confidence;
  const shouldAutoApprove =
    artifact.status === "draft" &&
    confidence === "high" &&
    autonomyLevel !== "supervised" &&
    !countdownPaused;

  // Start countdown for high-confidence artifacts in non-supervised mode
  useEffect(() => {
    if (shouldAutoApprove && countdown === null && !showRevisionInput) {
      setCountdown(COUNTDOWN_SECONDS);
    }
  }, [shouldAutoApprove]);

  useEffect(() => {
    if (countdown === null || countdown <= 0 || countdownPaused) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (countdown !== null && countdown <= 0 && !countdownPaused) {
        // Auto-approve
        updateArtifactStatus(artifact.id, "approved");
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      setCountdown((c) => (c !== null ? c - 1 : null));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [countdown, countdownPaused]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const cancelCountdown = () => {
    setCountdownPaused(true);
    setCountdown(null);
  };

  if (artifact.status === "approved") {
    return (
      <div className="flex items-center gap-2 pt-2 border-t border-border-default animate-approved rounded p-2">
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
    cancelCountdown();
    setSubmitting(true);
    await updateArtifactStatus(artifact.id, action, actionFeedback);
    setSubmitting(false);
    setShowRevisionInput(false);
    setFeedback("");
  };

  return (
    <div className="pt-3 border-t border-border-default space-y-2">
      {/* Auto-proceed countdown bar */}
      {countdown !== null && countdown > 0 && !countdownPaused && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-2xs text-accent-green">
              Will auto-approve in {countdown}s...
            </span>
            <button
              onClick={cancelCountdown}
              className="text-2xs text-text-muted hover:text-text-secondary press-scale"
            >
              Cancel
            </button>
          </div>
          <div className="h-0.5 bg-surface-elevated rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-green transition-all duration-1000 ease-linear"
              style={{ width: `${(countdown / COUNTDOWN_SECONDS) * 100}%` }}
            />
          </div>
        </div>
      )}

      {!showRevisionInput ? (
        <div className="flex gap-2">
          <button
            onClick={() => handleAction("approved")}
            disabled={submitting}
            className="px-3 py-1.5 bg-accent-green text-white text-xs font-medium rounded
                       hover:bg-accent-green/80 disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
          >
            Approve
          </button>
          <button
            onClick={() => { cancelCountdown(); setShowRevisionInput(true); }}
            disabled={submitting}
            className="px-3 py-1.5 bg-accent-amber-dim text-accent-amber text-xs font-medium rounded
                       hover:bg-accent-amber-dim/80 disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
          >
            Request Revision
          </button>
          <button
            onClick={() => handleAction("rejected")}
            disabled={submitting}
            className="px-3 py-1.5 bg-accent-red-dim text-accent-red text-xs font-medium rounded
                       hover:bg-accent-red-dim/80 disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
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
