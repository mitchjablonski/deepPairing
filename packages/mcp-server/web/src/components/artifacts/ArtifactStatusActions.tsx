import { useState, useEffect, useRef } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

interface ArtifactStatusActionsProps {
  artifact: Artifact;
}

const COUNTDOWN_SECONDS = 10;

const KEYBOARD_CONFIRM_SECONDS = 3;

export function ArtifactStatusActions({ artifact }: ArtifactStatusActionsProps) {
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { updateArtifactStatus, submitComment } = useArtifactStore();
  const autonomyLevel = useConnectionStore((s) => s.autonomyLevel);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  // Auto-proceed countdown state
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownMax, setCountdownMax] = useState(COUNTDOWN_SECONDS);
  const [countdownPaused, setCountdownPaused] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const confidence = (artifact.content as any)?.confidence;
  const shouldAutoApprove =
    artifact.status === "draft" &&
    confidence === "high" &&
    autonomyLevel !== "supervised" &&
    !countdownPaused;

  useEffect(() => {
    if (shouldAutoApprove && countdown === null && !comment) {
      setCountdownMax(COUNTDOWN_SECONDS);
      setCountdown(COUNTDOWN_SECONDS);
    }
  }, [shouldAutoApprove]);

  // Cancel countdown when user starts typing
  useEffect(() => {
    if (comment && countdown !== null) cancelCountdown();
  }, [comment]);

  useEffect(() => {
    if (countdown === null || countdown <= 0 || countdownPaused) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (countdown !== null && countdown <= 0 && !countdownPaused) {
        updateArtifactStatus(artifact.id, "approved");
      }
      return;
    }
    intervalRef.current = setInterval(() => {
      setCountdown((c) => (c !== null ? c - 1 : null));
    }, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [countdown, countdownPaused]);

  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  // Keyboard shortcut handler. App.tsx dispatches "dp:artifact-shortcut" when
  // the user presses `a` or `r` on the selected artifact. We NEVER commit
  // silently — `a` arms a short confirm countdown; `r` focuses the comment
  // textarea so the user must provide reasoning.
  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as { artifactId: string; action: "approve" | "revise" } | undefined;
      if (!detail || detail.artifactId !== artifact.id) return;
      if (artifact.status !== "draft") return;

      if (detail.action === "approve") {
        // Arm the same countdown UI used for confidence-auto-approve, but
        // shorter. User can press Esc (via Cancel) to bail.
        setCountdownPaused(false);
        setCountdownMax(KEYBOARD_CONFIRM_SECONDS);
        setCountdown(KEYBOARD_CONFIRM_SECONDS);
      } else {
        // Focus the comment textarea — user has to type a reason before
        // Request Revision becomes clickable.
        commentRef.current?.focus();
        commentRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      }
    };
    window.addEventListener("dp:artifact-shortcut", handler);
    return () => window.removeEventListener("dp:artifact-shortcut", handler);
  }, [artifact.id, artifact.status]);

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

  if (artifact.status === "revised") {
    return (
      <div className="flex items-center gap-2 pt-2 border-t border-border-default">
        <span className="text-accent-amber text-sm">&#x270E;</span>
        <span className="text-xs text-accent-amber font-medium">Revision requested</span>
        <span className="text-2xs text-text-muted ml-1">awaiting agent</span>
      </div>
    );
  }

  if (artifact.status === "reviewing") {
    return (
      <div className="flex items-center gap-2 pt-2 border-t border-border-default">
        <span className="inline-block w-2 h-2 rounded-full bg-accent-blue animate-pulse" />
        <span className="text-xs text-accent-blue font-medium">Under review</span>
      </div>
    );
  }

  if (artifact.status === "retracted") {
    const reason = (artifact.content as any)?.retractReason;
    return (
      <div className="pt-2 border-t border-border-default space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-text-muted text-sm">↩</span>
          <span className="text-xs text-text-muted font-medium">Retracted by agent</span>
        </div>
        {reason && (
          <div className="text-2xs text-text-muted italic pl-5">{reason}</div>
        )}
      </div>
    );
  }

  const handleAction = async (action: "approved" | "revised" | "rejected") => {
    cancelCountdown();
    setSubmitting(true);

    // Submit comment alongside the action if the user typed one
    const trimmedComment = comment.trim();
    if (trimmedComment) {
      await submitComment(artifact.id, trimmedComment);
    }

    await updateArtifactStatus(artifact.id, action, trimmedComment || undefined);
    setSubmitting(false);
    setComment("");
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
              style={{ width: `${(countdown / countdownMax) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Comment input — always visible, submitted with any action */}
      <textarea
        ref={commentRef}
        placeholder="Add a comment (optional — sent with your action)..."
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleAction("approved");
          }
        }}
        rows={2}
        className="w-full px-3 py-2 bg-surface-secondary border border-border-default rounded text-xs text-text-primary resize-none
                   placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue"
      />

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => handleAction("approved")}
          disabled={submitting}
          className="px-3 py-1.5 bg-accent-green text-white text-xs font-medium rounded
                     hover:bg-accent-green/80 disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
        >
          {comment.trim() ? "Approve with comment" : "Approve"}
        </button>
        <button
          onClick={() => handleAction("revised")}
          disabled={submitting || !comment.trim()}
          className="px-3 py-1.5 bg-accent-amber-dim text-accent-amber text-xs font-medium rounded
                     hover:bg-accent-amber-dim/80 disabled:opacity-30 transition-all duration-[180ms] ease-out press-scale"
          title={comment.trim() ? "" : "Add a comment to request revision"}
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
      {!comment.trim() && (
        <div className="text-2xs text-text-muted">
          Cmd+Enter to approve quickly
        </div>
      )}
    </div>
  );
}
