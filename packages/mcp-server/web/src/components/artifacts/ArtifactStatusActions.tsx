import { useEffect, useReducer, useRef } from "react";
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

// ---------------------------------------------------------------------------
// E6 — the footer state machine.
// ---------------------------------------------------------------------------
interface FooterState {
  comment: string;
  submitting: boolean;
  rejecting: boolean;
  rejectConcept: string;
  /** Armed auto/keyboard-approve countdown; null = disarmed. */
  countdown: number | null;
  countdownMax: number;
  /** A cancelled countdown STAYS paused so confidence-auto-arm can't re-fire. */
  countdownPaused: boolean;
  /** B6 — sentinel visibility (user reached the artifact's natural end). */
  atEnd: boolean;
  /** Voluntary expansion (Respond… click, textarea focus, `r` shortcut). */
  forceExpanded: boolean;
  /** B7 — manual Minimize; cleared by reaching the end (rising edge) or any engagement. */
  userCollapsed: boolean;
}

export const INITIAL_FOOTER_STATE: FooterState = {
  comment: "",
  submitting: false,
  rejecting: false,
  rejectConcept: "",
  countdown: null,
  countdownMax: COUNTDOWN_SECONDS,
  countdownPaused: false,
  atEnd: true,
  forceExpanded: false,
  userCollapsed: false,
};

type FooterAction =
  | { type: "typed"; comment: string }
  | { type: "armCountdown"; seconds: number }
  | { type: "cancelCountdown" }
  | { type: "tick" }
  | { type: "beginReject"; concept: string }
  | { type: "cancelReject" }
  | { type: "submitStart" }
  | { type: "submitEnd" }
  | { type: "actionSucceeded" }
  | { type: "respondSucceeded" }
  | { type: "rejectConceptTyped"; concept: string }
  | { type: "sentinel"; atEnd: boolean }
  | { type: "expand" }
  | { type: "minimize" };

/** The ONE cancellation semantics (B7 review: cancelling is ENGAGEMENT —
 *  without un-collapse, a user who minimized earlier had the panel snap to
 *  compact under their Cancel click). */
function cancelled(s: FooterState): FooterState {
  return { ...s, countdown: null, countdownPaused: true, userCollapsed: false };
}

export function footerReducer(s: FooterState, a: FooterAction): FooterState {
  switch (a.type) {
    case "typed": {
      const next = { ...s, comment: a.comment };
      // Typing cancels an armed countdown (was a dedicated effect).
      return a.comment && s.countdown !== null ? cancelled(next) : next;
    }
    case "armCountdown":
      return {
        ...s,
        countdownPaused: false,
        countdownMax: a.seconds,
        countdown: a.seconds,
      };
    case "cancelCountdown":
      return cancelled(s);
    case "tick":
      return s.countdown === null ? s : { ...s, countdown: s.countdown - 1 };
    case "beginReject":
      return { ...cancelled(s), rejecting: true, rejectConcept: a.concept };
    case "cancelReject":
      return { ...s, rejecting: false };
    case "submitStart":
      return { ...cancelled(s), submitting: true };
    case "submitEnd":
      return { ...s, submitting: false };
    case "actionSucceeded":
      // Only on success — a failed action keeps the text to retry. (Terminal
      // actions unmount the interactive footer anyway; the clearing matters
      // for state hygiene, not visibly.)
      return { ...s, comment: "", rejecting: false, rejectConcept: "" };
    case "respondSucceeded":
      // E6 review — Respond keeps an open reject panel AND the user's edited
      // concept (main's behavior): a clarifying comment mid-reject must not
      // discard the hand-tuned ledger key.
      return { ...s, comment: "" };
    case "rejectConceptTyped":
      // E6 review — typing the concept is JUST typing (main: setRejectConcept
      // only). Routing it through beginReject re-ran the cancel semantics —
      // convergent, but the machine should say what it does.
      return { ...s, rejectConcept: a.concept };
    case "sentinel":
      // B7' — reaching the end re-opens a minimized panel (rising edge only:
      // minimizing while AT the end sticks until you scroll away and return).
      // Duplicate notifications bail (matches main's same-value setState):
      // IntersectionObserver only notifies on crossings per spec, but a
      // duplicate must not clear a Minimize or mint a render.
      if (a.atEnd === s.atEnd) return s;
      return a.atEnd
        ? { ...s, atEnd: true, userCollapsed: false }
        : { ...s, atEnd: false };
    case "expand":
      return { ...s, userCollapsed: false, forceExpanded: true };
    case "minimize":
      return { ...s, userCollapsed: true, forceExpanded: false };
  }
}

export function ArtifactStatusActions({ artifact, hideApprove = false }: ArtifactStatusActionsProps) {
  const updateArtifactStatus = useArtifactStore((s) => s.updateArtifactStatus);
  const submitComment = useArtifactStore((s) => s.submitComment);
  const autonomyLevel = useConnectionStore((s) => s.autonomyLevel);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  // Reject-concept capture: rejecting is the highest-value teaching moment, so
  // we name the PATTERN being rejected (the cross-project ledger key) instead
  // of letting the moat key on the artifact title. Clicking Reject reveals a
  // field pre-filled with the agent's own concept (when it named one), editable.
  const agentConcept = (artifact.content as { concept?: { name?: string } } | null)?.concept?.name;

  // E6 — the footer machine is a REDUCER (was 10 useState + 8 effects, three
  // of which existed only to cancel the countdown when some OTHER state
  // changed). The cross-state rules are transitions now:
  //   - typing cancels an armed countdown (was its own effect)
  //   - reaching the end clears a manual Minimize — rising edge, B7' (was its
  //     own effect)
  //   - EVERY countdown cancellation (user Cancel, typing, submit-start,
  //     hideApprove suppression) shares ONE semantics: pause + clear +
  //     un-collapse (the B7 engagement rule)
  // Remaining effects are IO only: interval tick + approve-at-zero, the
  // IntersectionObserver, focus-after-expand, and the shortcut listener.
  const [state, dispatch] = useReducer(footerReducer, INITIAL_FOOTER_STATE);
  const {
    comment, submitting, rejecting, rejectConcept,
    countdown, countdownMax, countdownPaused,
    atEnd, forceExpanded, userCollapsed,
  } = state;

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // B6 — end-of-artifact sentinel drives compact-while-floating (see the
  // render). atEnd defaults TRUE so test envs without IntersectionObserver
  // (and short artifacts) keep the full footer.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) =>
      dispatch({ type: "sentinel", atEnd: entry.isIntersecting }),
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const mustExpand = countdown !== null || rejecting || comment.trim().length > 0;
  const expanded = mustExpand || (!userCollapsed && (atEnd || forceExpanded));

  // Focus must happen AFTER the expanded render commits (the textarea doesn't
  // exist while compact). An effect keyed on forceExpanded is deterministic
  // where a requestAnimationFrame race isn't (and rAF never fires in jsdom).
  const wantFocusRef = useRef(false);
  useEffect(() => {
    if (forceExpanded && wantFocusRef.current) {
      wantFocusRef.current = false;
      commentRef.current?.focus();
      commentRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
  }, [forceExpanded]);
  const expandAndFocus = () => {
    wantFocusRef.current = true;
    dispatch({ type: "expand" });
    // Already expanded (e.g. atEnd) → the effect won't re-fire; focus directly.
    commentRef.current?.focus();
  };

  const confidence = (artifact.content as any)?.confidence;
  const shouldAutoApprove =
    artifact.status === "draft" &&
    confidence === "high" &&
    autonomyLevel !== "supervised" &&
    !countdownPaused &&
    !hideApprove; // parent owns approval (e.g. unchecked plan steps) — don't auto-approve as-is

  useEffect(() => {
    if (shouldAutoApprove && countdown === null && !comment) {
      dispatch({ type: "armCountdown", seconds: COUNTDOWN_SECONDS });
    }
  }, [shouldAutoApprove]);

  // U3 — if approval gets suppressed mid-countdown (e.g. the user unchecks a
  // plan step after pressing `a`), cancel the armed countdown. Otherwise it
  // would tick to 0 and approve the plan as-is, discarding the deselection —
  // exactly the footgun hideApprove exists to prevent.
  useEffect(() => {
    if (hideApprove && countdown !== null) dispatch({ type: "cancelCountdown" });
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
      dispatch({ type: "tick" });
    }, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [countdown, countdownPaused]);

  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as { artifactId: string; action: "approve" | "revise" } | undefined;
      if (!detail || detail.artifactId !== artifact.id) return;
      if (artifact.status !== "draft") return;

      if (detail.action === "approve" && !hideApprove) {
        // Arm the same countdown UI used for confidence-auto-approve, but
        // shorter. User can press Esc (via Cancel) to bail.
        dispatch({ type: "armCountdown", seconds: KEYBOARD_CONFIRM_SECONDS });
      } else {
        // Request Revision (needs a reason), OR an approve shortcut while the
        // parent owns approval (hideApprove) — either way, focus the comment
        // textarea instead of approving as-is.
        // B6 review — while the footer floats COMPACT the textarea is
        // unmounted, so commentRef is null and this was a silent no-op (the
        // `r` shortcut died on exactly the long artifacts that float). Expand
        // first; the forceExpanded effect focuses after the commit.
        wantFocusRef.current = true;
        dispatch({ type: "expand" });
        commentRef.current?.focus();
        commentRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      }
    };
    window.addEventListener("dp:artifact-shortcut", handler);
    return () => window.removeEventListener("dp:artifact-shortcut", handler);
  }, [artifact.id, artifact.status, hideApprove]);

  // B7 review semantics (cancel = engagement) live in the reducer's
  // `cancelled()` — shared by user Cancel, typing, submit-start, hideApprove.
  const cancelCountdown = () => dispatch({ type: "cancelCountdown" });

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
    dispatch({ type: "submitStart" });
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
      dispatch({ type: "actionSucceeded" }); // only on success — a failed action keeps the text to retry
    } catch {
      // The store mutations re-throw AFTER toasting a user-facing error. Swallow
      // here so the click handler doesn't reject — but the `finally` MUST run so
      // the panel re-enables; otherwise a single failed Approve/Reject disables
      // every action forever (the U3 "approve doesn't land" class of bug).
    } finally {
      dispatch({ type: "submitEnd" });
    }
  };

  // Reject is two-step: the first click reveals the "name the pattern" field
  // (pre-filled with the agent's concept); the confirm click does the reject.
  const beginReject = () => dispatch({ type: "beginReject", concept: agentConcept ?? "" });

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
    dispatch({ type: "submitStart" });
    try {
      await submitComment(artifact.id, trimmedComment);
      dispatch({ type: "respondSucceeded" }); // only clears on success
    } catch {
      // store already toasted; keep the panel usable (see handleAction)
    } finally {
      dispatch({ type: "submitEnd" });
    }
  };

  /**
   * "Dismiss — overcome by new information": close a still-open artifact that
   * the discussion moved past, without approving or rejecting it. Mirrors the
   * agent's `revise_artifact mode="obsolete"` so it leaves the review queue.
   * Any typed comment rides along as the reason.
   */
  const handleDismissObsolete = async () => {
    dispatch({ type: "submitStart" });
    try {
      await updateArtifactStatus(artifact.id, "obsolete", comment.trim() || undefined);
      dispatch({ type: "actionSucceeded" }); // only clears on success
    } catch {
      // store already toasted; keep the panel usable (see handleAction)
    } finally {
      dispatch({ type: "submitEnd" });
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
    <>
      {/* B6 — end-of-artifact sentinel: visible ⇒ the user reached the bottom
          ⇒ show the full panel. While it's off-screen the footer floats in
          compact form. */}
      <div ref={sentinelRef} aria-hidden className="h-px" />
      <div className="sticky bottom-0 z-10 -mb-1 pb-1 bg-surface-primary pt-3 border-t border-border-default space-y-2" /* solid bg: content ghosted readably through the old /95+blur edge */>
      {!expanded ? (
        // B6 — slim floating bar: Approve stays one click (the bound approve),
        // everything needing a reason expands + focuses the textarea.
        <div className="flex items-center gap-2 pb-2">
          {!hideApprove && (
            <button
              onClick={() => handleAction("approved")}
              disabled={submitting}
              className="px-2.5 py-1 text-2xs font-medium text-accent-green rounded border border-accent-green/30
                         hover:bg-accent-green-dim disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
              title="Approve as-is"
            >
              Approve
            </button>
          )}
          <button
            onClick={expandAndFocus}
            className="px-2.5 py-1 text-2xs font-medium text-text-secondary rounded border border-border-default
                       hover:text-text-primary hover:bg-surface-hover transition-all duration-[180ms] ease-out press-scale"
            title="Respond, request a revision, or reject — opens the full review panel"
          >
            Respond / revise / reject…
          </button>
          <span className="text-2xs text-text-muted ml-auto" aria-hidden>
            ▼ full review at the end
          </span>
        </div>
      ) : (
      <>
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
        // B6 review — once the user engages the panel, latch it open:
        // otherwise select-all-delete while scrolled mid-artifact flipped
        // `expanded` false and unmounted the textarea UNDER their cursor.
        onFocus={() => dispatch({ type: "expand" })}
        onChange={(e) => dispatch({ type: "typed", comment: e.target.value })}
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

        {/* B7 — collapse back to the slim bar. Lives in the action row
            (right-aligned) so it isn't crowded against the message composer
            below the pane. Hidden while something mandates the full panel
            (countdown/reject/typed text) — a dead control lies. Scrolling
            back to the end re-opens automatically. */}
        {!mustExpand && (
          <button
            type="button"
            onClick={() => dispatch({ type: "minimize" })}
            className="ml-auto text-2xs text-text-muted hover:text-text-secondary transition-colors shrink-0"
            title="Collapse to the slim bar (Approve stays one click; reaching the end re-opens)"
          >
            Minimize ▾
          </button>
        )}
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
            onChange={(e) => dispatch({ type: "rejectConceptTyped", concept: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); handleAction("rejected"); }
              if (e.key === "Escape") { e.preventDefault(); dispatch({ type: "cancelReject" }); }
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
              onClick={() => dispatch({ type: "cancelReject" })}
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
      </>
      )}
      </div>
    </>
  );
}
