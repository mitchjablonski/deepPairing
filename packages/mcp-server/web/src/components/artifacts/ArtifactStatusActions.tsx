import { useState, useEffect, useRef } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

interface ArtifactStatusActionsProps {
  artifact: Artifact;
  /** Hide the plain Approve affordance (and disable auto-approve) when the
   *  parent supplies its own approve path — e.g. PlanArtifact's "Approve with
   *  modifications" while steps are unchecked. Without this, a plain Approve
   *  would silently approve the plan as-is and discard the human's step
   *  deselections. Reject / Request revision / Respond / Ask stay available. */
  hideApprove?: boolean;
}

const COUNTDOWN_SECONDS = 10;

const KEYBOARD_CONFIRM_SECONDS = 3;

export function ArtifactStatusActions({ artifact, hideApprove = false }: ArtifactStatusActionsProps) {
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const updateArtifactStatus = useArtifactStore((s) => s.updateArtifactStatus);
  const submitComment = useArtifactStore((s) => s.submitComment);
  const autonomyLevel = useConnectionStore((s) => s.autonomyLevel);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  // Reject-concept capture: rejecting is the highest-value teaching moment, so
  // we name the PATTERN being rejected (the cross-project ledger key) instead
  // of letting the moat key on the artifact title. Clicking Reject reveals a
  // field pre-filled with the agent's own concept (when it named one), editable.
  const agentConcept = (artifact.content as { concept?: { name?: string } } | null)?.concept?.name;
  const [rejecting, setRejecting] = useState(false);
  const [rejectConcept, setRejectConcept] = useState("");

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
    !countdownPaused &&
    !hideApprove; // parent owns approval (e.g. unchecked plan steps) — don't auto-approve as-is

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

  // U3 — if approval gets suppressed mid-countdown (e.g. the user unchecks a
  // plan step after pressing `a`), cancel the armed countdown. Otherwise it
  // would tick to 0 and approve the plan as-is, discarding the deselection —
  // exactly the footgun hideApprove exists to prevent.
  useEffect(() => {
    if (hideApprove && countdown !== null) cancelCountdown();
  }, [hideApprove]);

  useEffect(() => {
    if (countdown === null || countdown <= 0 || countdownPaused) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      // The !hideApprove guard is belt-and-suspenders: the effect above already
      // cancels on hideApprove, but never auto-approve while approval is suppressed.
      if (countdown !== null && countdown <= 0 && !countdownPaused && !hideApprove) {
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

      if (detail.action === "approve" && !hideApprove) {
        // Arm the same countdown UI used for confidence-auto-approve, but
        // shorter. User can press Esc (via Cancel) to bail.
        setCountdownPaused(false);
        setCountdownMax(KEYBOARD_CONFIRM_SECONDS);
        setCountdown(KEYBOARD_CONFIRM_SECONDS);
      } else {
        // Request Revision (needs a reason), OR an approve shortcut while the
        // parent owns approval (hideApprove) — either way, focus the comment
        // textarea instead of approving as-is.
        commentRef.current?.focus();
        commentRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      }
    };
    window.addEventListener("dp:artifact-shortcut", handler);
    return () => window.removeEventListener("dp:artifact-shortcut", handler);
  }, [artifact.id, artifact.status, hideApprove]);

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
        {/* UX7b — same glyph as the sidebar/header statusGlyph.revised (↻),
            not a pencil, so "revised" reads consistently across surfaces. */}
        <span className="text-accent-amber text-sm">↻</span>
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

  if (artifact.status === "obsolete") {
    return (
      <div className="flex items-center gap-2 pt-2 border-t border-border-default">
        <span className="text-text-muted text-sm">⊘</span>
        <span className="text-xs text-text-muted font-medium">Overcome by new information</span>
      </div>
    );
  }

  const handleAction = async (action: "approved" | "revised" | "rejected") => {
    cancelCountdown();
    setSubmitting(true);
    try {
      // Submit comment alongside the action if the user typed one
      const trimmedComment = comment.trim();
      if (trimmedComment) {
        await submitComment(artifact.id, trimmedComment);
      }
      // On reject, carry the human-named pattern as the ledger key (empty →
      // server falls back to the agent's concept, then the title).
      const concept = action === "rejected" ? rejectConcept.trim() || undefined : undefined;
      await updateArtifactStatus(artifact.id, action, trimmedComment || undefined, concept);
      setComment(""); // only clear on success, so a failed action keeps the text to retry
      setRejecting(false);
      setRejectConcept("");
    } catch {
      // The store mutations re-throw AFTER toasting a user-facing error. Swallow
      // here so the click handler doesn't reject — but the `finally` MUST run so
      // the panel re-enables; otherwise a single failed Approve/Reject disables
      // every action forever (the U3 "approve doesn't land" class of bug).
    } finally {
      setSubmitting(false);
    }
  };

  // Reject is two-step: the first click reveals the "name the pattern" field
  // (pre-filled with the agent's concept); the confirm click does the reject.
  const beginReject = () => {
    cancelCountdown();
    setRejectConcept(agentConcept ?? "");
    setRejecting(true);
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
    try {
      await submitComment(artifact.id, trimmedComment);
      setComment(""); // only clear on success
    } catch {
      // store already toasted; keep the panel usable (see handleAction)
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * "Dismiss — overcome by new information": close a still-open artifact that
   * the discussion moved past, without approving or rejecting it. Mirrors the
   * agent's `revise_artifact mode="obsolete"` so it leaves the review queue.
   * Any typed comment rides along as the reason.
   */
  const handleDismissObsolete = async () => {
    cancelCountdown();
    setSubmitting(true);
    try {
      await updateArtifactStatus(artifact.id, "obsolete", comment.trim() || undefined);
      setComment(""); // only clear on success
    } catch {
      // store already toasted; keep the panel usable (see handleAction)
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // B2 — STICKY at the bottom of the scrolling detail pane. On a long
    // artifact (10 findings, a multi-file plan) the review actions — and worse,
    // the ARMED AUTO-APPROVE COUNTDOWN — sat several screens below the fold: a
    // timer could tick to commit while invisible. Sticky keeps the decision the
    // human must make (and any running countdown) always on screen. Works
    // because this is a direct child of each renderer root inside the
    // overflow-y-auto pane (no intermediate overflow ancestor).
    <div className="sticky bottom-0 z-10 -mb-1 pb-1 bg-surface-primary/95 backdrop-blur-sm pt-3 border-t border-border-default space-y-2">
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
            } else if (!hideApprove) {
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
          {!hideApprove && (
            <button
              onClick={() => handleAction("approved")}
              disabled={submitting}
              className="px-2.5 py-1 text-2xs font-medium text-accent-green rounded border border-accent-green/30
                         hover:bg-accent-green-dim disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
              title={comment.trim() ? "Approve and send this comment" : "Approve as-is"}
            >
              {comment.trim() ? "Approve with note" : "Approve"}
            </button>
          )}
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
            onClick={beginReject}
            disabled={submitting || !comment.trim() || rejecting}
            className="px-2.5 py-1 text-2xs font-medium text-accent-red rounded border border-accent-red/30
                       hover:bg-accent-red-dim disabled:opacity-30 transition-all duration-[180ms] ease-out press-scale"
            title={comment.trim() ? "Reject and remember this pattern across sessions" : "Add a reason first"}
          >
            Reject
          </button>
        </div>
      </div>

      {/* Reject confirm: name the pattern (the cross-project ledger key) so a
          future paraphrase gets caught — not just this artifact's title. */}
      {rejecting && (
        <div className="space-y-1.5 p-2.5 rounded border border-accent-red/30 bg-accent-red-dim/15">
          <label htmlFor="reject-concept" className="block text-2xs font-medium text-text-secondary">
            What pattern are you rejecting?{" "}
            <span className="font-normal text-text-muted">
              This becomes your cross-project memory key — so the agent can’t paraphrase past it later.
            </span>
          </label>
          <input
            id="reject-concept"
            autoFocus
            value={rejectConcept}
            onChange={(e) => setRejectConcept(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); handleAction("rejected"); }
              if (e.key === "Escape") { e.preventDefault(); setRejecting(false); }
            }}
            placeholder="e.g. “global mutable state for config”"
            className="w-full px-2 py-1 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                       placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-red"
          />
          {agentConcept && (
            <div className="text-[10px] text-text-muted">
              Pre-filled from the agent’s named concept — edit it to match how <em>you’d</em> phrase the rule.
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleAction("rejected")}
              disabled={submitting}
              className="px-2.5 py-1 text-2xs font-medium text-white bg-accent-red rounded
                         hover:bg-accent-red/80 disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
              title="Reject and remember this pattern across every project"
            >
              Reject &amp; remember
            </button>
            <button
              onClick={() => setRejecting(false)}
              disabled={submitting}
              className="text-2xs text-text-muted hover:text-text-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tertiary — close as overcome by new information (neither approve nor
          reject). Mirrors the agent's revise_artifact mode="obsolete". */}
      <button
        onClick={handleDismissObsolete}
        disabled={submitting}
        className="text-2xs text-text-muted hover:text-text-secondary disabled:opacity-50 transition-colors"
        title="This was valid but the discussion moved past it — close it without approving or rejecting"
      >
        Dismiss — overcome by new information
      </button>

      {!comment.trim() && (
        <div className="text-2xs text-text-muted">
          ⌘⏎ on empty input approves · Reject / Revise need a reason (remembered across sessions)
        </div>
      )}
    </div>
  );
}
