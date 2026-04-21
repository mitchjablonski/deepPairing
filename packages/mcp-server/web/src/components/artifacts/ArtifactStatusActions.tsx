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

  /**
   * "Respond" — post the comment to the artifact WITHOUT changing status.
   * This is the pairing-primary action: a pair doesn't approve, they reply.
   * The agent picks the comment up via check_feedback and may iterate
   * (often via revise_artifact with mode='supersede'). Approve/Revise/Reject
   * remain as explicit terminal actions.
   */
  const handleRespond = async () => {
    const trimmedComment = comment.trim();
    if (!trimmedComment) return;
    cancelCountdown();
    setSubmitting(true);
    await submitComment(artifact.id, trimmedComment);
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

      {/* Comment/response textarea. Submitting it as a "Respond" (the primary
          action) keeps the artifact in draft — the agent picks the comment
          up and iterates. Approve/Revise/Reject are secondary terminal
          actions. Cmd+Enter sends a Respond when there's text, or an Approve
          when the field is empty (fast-path for "looks good"). */}
      <textarea
        ref={commentRef}
        placeholder="Respond to the agent…  (⌘⏎ to send · empty ⌘⏎ = approve)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (comment.trim()) {
              handleRespond();
            } else {
              handleAction("approved");
            }
          }
        }}
        rows={2}
        className="w-full px-3 py-2 bg-surface-secondary border border-border-default rounded text-xs text-text-primary resize-none
                   placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet"
      />

      {/* Primary action: Respond (pair programming default) */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleRespond}
          disabled={submitting || !comment.trim()}
          className="px-3 py-1.5 bg-accent-violet text-white text-xs font-medium rounded
                     hover:bg-accent-violet/80 disabled:bg-surface-elevated disabled:text-text-muted
                     transition-all duration-[180ms] ease-out press-scale"
          title="Send the comment; the agent will iterate (keeps artifact in draft)"
        >
          Respond
        </button>

        <span className="text-2xs text-text-muted">or</span>

        {/* Secondary terminal actions as outline pills */}
        <div className="flex gap-1.5">
          <button
            onClick={() => handleAction("approved")}
            disabled={submitting}
            className="px-2.5 py-1 text-2xs font-medium text-accent-green rounded border border-accent-green/30
                       hover:bg-accent-green-dim disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
            title={comment.trim() ? "Approve and send this comment" : "Approve as-is"}
          >
            {comment.trim() ? "Approve with note" : "Approve"}
          </button>
          <button
            onClick={() => handleAction("revised")}
            disabled={submitting || !comment.trim()}
            className="px-2.5 py-1 text-2xs font-medium text-accent-amber rounded border border-accent-amber/30
                       hover:bg-accent-amber-dim disabled:opacity-30 transition-all duration-[180ms] ease-out press-scale"
            title={comment.trim() ? "Mark revised — agent will redraft" : "Add a reason first"}
          >
            Request revision
          </button>
          <button
            onClick={() => handleAction("rejected")}
            disabled={submitting || !comment.trim()}
            className="px-2.5 py-1 text-2xs font-medium text-accent-red rounded border border-accent-red/30
                       hover:bg-accent-red-dim disabled:opacity-30 transition-all duration-[180ms] ease-out press-scale"
            title={comment.trim() ? "Reject and remember the reason across sessions" : "Add a reason first"}
          >
            Reject
          </button>
        </div>
      </div>
      {!comment.trim() && (
        <div className="text-2xs text-text-muted">
          ⌘⏎ on empty input approves · Reject / Revise need a reason (remembered across sessions)
        </div>
      )}
    </div>
  );
}
