import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";
import { useChainComments } from "../../hooks/useChainComments";
import { summarizeOpenSuggestions, openSuggestionsConfirmLabel } from "../../lib/openSuggestions";

interface ArtifactStatusActionsProps {
  artifact: Artifact;
  /** Hide the plain Approve affordance (and disable auto-approve) when the
   *  parent supplies its own approve path — e.g. PlanArtifact's "Approve with
   *  modifications" while steps are unchecked. Without this, a plain Approve
   *  would silently approve the plan as-is and discard the human's step
   *  deselections. Reject / Request changes / Respond / Ask stay available. */
  hideApprove?: boolean;
  /** #193 E2 — the read-only comprehension lifecycle (the EXPLAINER). Replaces
   *  the verdict triad entirely with an ACKNOWLEDGE footer: one primary "Got it"
   *  (approves under the hood — reuses the status machinery, relabeled) plus a
   *  secondary "Ask more" that focuses the artifact's ask-anything composer.
   *  NO Reject, NO Request-changes — nothing here proposes an approach, so there
   *  is no taste stance to capture and no redraft to demand. */
  acknowledgeMode?: boolean;
  /** #193 E2 — called when the human clicks "Ask more" in acknowledge mode; the
   *  parent focuses its ask-anything composer. */
  onAskMore?: () => void;
  /** #193 E2 — suppress the reject-concept ("name the pattern") ledger capture
   *  (the DEBRIEF). The debrief keeps Approve / Request-changes / Reject, but a
   *  rejected debrief is an account of finished work, not a proposed approach —
   *  so Reject records NO cross-project taste stance. Reject becomes a one-step
   *  "redo the digest" (the typed reason rides along); the plain rejected status
   *  still lands. The server guards this authoritatively too. */
  suppressRejectConcept?: boolean;
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

export function ArtifactStatusActions({
  artifact,
  hideApprove = false,
  acknowledgeMode = false,
  onAskMore,
  suppressRejectConcept = false,
}: ArtifactStatusActionsProps) {
  // F12 — replay renders HISTORICAL artifacts through the live components,
  // and F6 owner-routing means a footer click would write a verdict into a
  // long-exited session's store. The whole footer goes read-only.
  const replayActive = useReplayStore((s) => s.active);
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

  // H1 (#202) — the approve gate. Approving while the human's own suggested
  // edits sit pending/countered silently abandons their proposal (the asymmetry
  // with withdraw_artifact the round-4 UX lens flagged). Every FINALIZING
  // approve path — the button, ⌘⏎-on-empty, and the `a`/⏎ keymap's countdown —
  // routes through the gate: it shows a one-line inline confirm naming the open
  // states instead of committing. Confirming ("Approve anyway") proceeds — the
  // human's explicit call, never a hard-block. A ref keeps the countdown-tick
  // effect reading the freshest summary without re-subscribing.
  const chainComments = useChainComments(artifact.id);
  const openSug = useMemo(() => summarizeOpenSuggestions(chainComments), [chainComments]);
  const openSugRef = useRef(openSug);
  openSugRef.current = openSug;
  const [approveConfirm, setApproveConfirm] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // B6 — end-of-artifact sentinel drives compact-while-floating (see the
  // render). atEnd defaults TRUE so test envs without IntersectionObserver
  // (and short artifacts) keep the full footer.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry) dispatch({ type: "sentinel", atEnd: entry.isIntersecting });
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const mustExpand = countdown !== null || rejecting || comment.trim().length > 0;
  const expanded = mustExpand || (!userCollapsed && (atEnd || forceExpanded));

  // Focus must happen AFTER the expanded render commits (the textarea doesn't
  // exist while compact). An effect keyed on forceExpanded is deterministic
  // where a requestAnimationFrame race isn't (and rAF never fires in jsdom).
  const wantFocusRef = useRef(false);
  // F10 (G5) — the shortcut listener's deps deliberately exclude `comment`
  // (re-subscribing per keystroke); a ref keeps the read fresh.
  const hasCommentRef = useRef(false);
  const approvedChipFocusedRef = useRef(false);
  hasCommentRef.current = comment.trim().length > 0;
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

  // F8 (M3) — the ? help and the arm comment BOTH promised "Esc to cancel";
  // no Escape path existed (App's handler only closes overlays). Scoped to
  // an armed countdown so it can't swallow overlay Escapes.
  const countdownArmed = countdown !== null && !countdownPaused;
  useEffect(() => {
    if (!countdownArmed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dispatch({ type: "cancelCountdown" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Derived boolean, not [countdown, paused] — the tick decrements countdown
    // every second and re-attaching the window listener per tick is waste.
  }, [countdownArmed]);

  const confidence = (artifact.content as any)?.confidence;
  const shouldAutoApprove =
    // F12 review — without this the countdown armed INVISIBLY during replay
    // (the chip hides the bar) and phantom-toasted a refusal ~10s later.
    !replayActive &&
    artifact.status === "draft" &&
    confidence === "high" &&
    autonomyLevel !== "supervised" &&
    !countdownPaused &&
    !hideApprove; // parent owns approval (e.g. unchecked plan steps) — don't auto-approve as-is

  useEffect(() => {
    if (shouldAutoApprove && countdown === null && !comment) {
      dispatch({ type: "armCountdown", seconds: COUNTDOWN_SECONDS });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- E6 reducer: typing-cancels-countdown is a transition, not a dep — see the reducer header
  }, [shouldAutoApprove]);

  // U3 — if approval gets suppressed mid-countdown (e.g. the user unchecks a
  // plan step after pressing `a`), cancel the armed countdown. Otherwise it
  // would tick to 0 and approve the plan as-is, discarding the deselection —
  // exactly the footgun hideApprove exists to prevent.
  useEffect(() => {
    if (hideApprove && countdown !== null) dispatch({ type: "cancelCountdown" });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- E6 reducer: the cancel keys on the hideApprove transition; the countdown !== null read is a guard, not an input
  }, [hideApprove]);

  useEffect(() => {
    if (countdown === null || countdown <= 0 || countdownPaused) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      // The !hideApprove guard is belt-and-suspenders: the effect above already
      // cancels on hideApprove, but never auto-approve while approval is suppressed.
      if (countdown !== null && countdown <= 0 && !countdownPaused && !hideApprove) {
        // H1 (#202) — the countdown is how the `a`/⏎ keymap AND confidence
        // auto-approve commit. Route BOTH through the open-suggestion gate: with
        // an open suggestion the window elapsing surfaces the confirm instead of
        // silently approving.
        if (openSugRef.current.total > 0) {
          setApproveConfirm(true);
        } else {
          updateArtifactStatus(artifact.id, "approved");
        }
      }
      return;
    }
    intervalRef.current = setInterval(() => {
      dispatch({ type: "tick" });
    }, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- E6 reducer: tick keys on armed-state only; each countdown change re-runs with a fresh closure, and updates flow through dispatch
  }, [countdown, countdownPaused]);

  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as { artifactId: string; action: "approve" | "revise" } | undefined;
      if (!detail || detail.artifactId !== artifact.id) return;
      if (artifact.status !== "draft") return;

      // F10 (G5) — a typed note must never be silently dropped: the zero-tick
      // approves via updateArtifactStatus directly (no submitComment), so
      // arming with text pending lost the note while the visible button
      // promised 'Approve with note'. With a note, `a` behaves like the
      // revise branch instead: expand + focus so the user finishes the
      // thought and clicks the action that carries it. (The confidence
      // auto-arm already gates on !comment for the same reason.)
      if (detail.action === "approve" && !hideApprove && !hasCommentRef.current) {
        // H1 (#202) — the `a`/⏎ keymap must hit the same open-suggestion gate.
        // With a suggestion open, surface the confirm immediately rather than
        // arming a countdown that would only reveal it at zero.
        if (openSugRef.current.total > 0) {
          setApproveConfirm(true);
          return;
        }
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

  // F12 — replay: replace the mutating footer with a read-only chip.
  // Terminal statuses fall through to their passive chips below (they don't
  // mutate). This sits above the draft footer so no approve/reject/dismiss
  // affordance renders against a historical frame.
  if (replayActive && artifact.status === "draft") {
    return (
      <div className="flex items-center gap-2 pt-2 border-t border-border-default">
        <span className="text-xs text-text-muted font-medium">⏸ Replay — read-only</span>
        <span className="text-2xs text-text-muted">exit replay to review</span>
      </div>
    );
  }

  if (artifact.status === "approved") {
    return (
      <div
        // H1 (a11y) — the approve paths unmount the focused control (Cancel
        // button / textarea) when this chip replaces the footer; focus fell
        // to <body> and keyboard users re-tabbed from the top. The chip is
        // focusable-by-script and takes focus on mount IF the footer held it.
        ref={(el) => {
          // Review — ONE-SHOT: inline refs re-attach on every render, and
          // re-focusing whenever activeElement is <body> yanked focus (and
          // scroll) back to the chip on any WS-driven re-render.
          if (
            el &&
            !approvedChipFocusedRef.current &&
            (document.activeElement === document.body || document.activeElement === null)
          ) {
            approvedChipFocusedRef.current = true;
            el.focus();
          }
        }}
        tabIndex={-1}
        className="flex items-center gap-2 pt-2 border-t border-border-default animate-approved rounded p-2 focus:outline-none"
      >
        <span className="text-accent-green text-sm">&#10003;</span>
        {/* #193 E2 — in acknowledge mode "approved" reads as "read + understood",
            not a verdict. The chip says "Read" — the SAME word the header chip
            uses (statusLabelFor), so the acknowledged state reads coherently in
            both places (the button that got here is "Got it"). */}
        <span className="text-xs text-accent-green font-medium">{acknowledgeMode ? "Read" : "Approved"}</span>
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
        {/* F8 (L4) — violet with the panel dot: revised = agent's turn. */}
        <span className="text-accent-violet text-sm">↻</span>
        <span className="text-xs text-accent-violet font-medium">Revision requested</span>
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

  const handleAction = async (
    action: "approved" | "revised" | "rejected",
    opts?: { bypassSuggestionGate?: boolean },
  ) => {
    // H1 (#202) — gate a FINALIZING approve behind the inline confirm when the
    // human's own suggestions are still open. Reject/Request-changes are never
    // gated (they don't abandon a proposal). "Approve anyway" passes the bypass.
    if (action === "approved" && !opts?.bypassSuggestionGate && openSugRef.current.total > 0) {
      setApproveConfirm(true);
      return;
    }
    setApproveConfirm(false);
    dispatch({ type: "submitStart" });
    try {
      // Submit comment alongside the action if the user typed one
      const trimmedComment = comment.trim();
      if (trimmedComment) {
        await submitComment(artifact.id, trimmedComment);
      }
      // On reject, carry the human-named pattern as the ledger key (empty →
      // server falls back to the agent's concept, then the title).
      // #193 E2 — a debrief reject (suppressRejectConcept) records NO stance, so
      // never send a concept; the server refuses it too, but don't even offer it.
      const concept = action === "rejected" && !suppressRejectConcept ? rejectConcept.trim() || undefined : undefined;
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
  // #193 E2 — a debrief reject captures no stance, so there's no pattern to
  // name: skip the second step and reject in one click (the typed reason rides
  // along as "redo the digest" feedback).
  const beginReject = () =>
    suppressRejectConcept
      ? handleAction("rejected")
      : dispatch({ type: "beginReject", concept: agentConcept ?? "" });

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

  /**
   * #193 E2 — "Got it": acknowledge the read-only comprehension artifact. Marks
   * it approved under the hood (reusing the exact status machinery), which drains
   * it from the "waiting on you" queue — the artifact WAS the human's turn (read
   * it), and clicking Got it hands the turn back. No comment, no verdict semantics.
   */
  const handleAcknowledge = async () => {
    dispatch({ type: "submitStart" });
    try {
      await updateArtifactStatus(artifact.id, "approved");
      dispatch({ type: "actionSucceeded" });
    } catch {
      // store already toasted; keep the panel usable (see handleAction)
    } finally {
      dispatch({ type: "submitEnd" });
    }
  };

  // #193 E2 — the EXPLAINER's acknowledge footer: a lightened, verdict-free bar.
  // "Got it" (approves) + "Ask more" (focuses the ask-anything composer). Sits in
  // the same sticky slot as the verdict footer but carries no textarea, no
  // reject, no request-changes — the read-only teaching artifact is the human's
  // to READ, then dismiss, not to adjudicate.
  if (acknowledgeMode) {
    return (
      <>
        <div ref={sentinelRef} aria-hidden className="h-px" />
        <div className="sticky bottom-0 z-10 -mb-1 pb-1 bg-surface-primary pt-3 border-t border-border-default">
          <div className="flex items-center gap-2 pb-1">
            <button
              onClick={handleAcknowledge}
              disabled={submitting}
              className="px-3 py-1.5 text-xs font-medium text-accent-green rounded border border-accent-green/40
                         hover:bg-accent-green-dim disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
              title="Mark this walk-through read — hands the turn back to the agent"
            >
              &#10003; Got it
            </button>
            {onAskMore && (
              <button
                onClick={onAskMore}
                className="px-2.5 py-1 text-2xs font-medium text-text-secondary rounded border border-border-default
                           hover:text-text-primary hover:bg-surface-hover transition-all duration-[180ms] ease-out press-scale"
                title="Ask a follow-up — jumps to the ask-anything box"
              >
                Ask more
              </button>
            )}
            <span className="text-2xs text-text-muted ml-auto" aria-hidden>
              Read-only — nothing to approve or reject
            </span>
          </div>
        </div>
      </>
    );
  }

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
      {/* H1 (#202) — the open-suggestion approve gate. Shown in place of a silent
          commit; naming the open states so the human knows what approving
          abandons. "Approve anyway" is their explicit call (bypasses the gate);
          "Keep reviewing" dismisses. */}
      {approveConfirm && (
        <div
          data-testid="approve-open-suggestions-confirm"
          className="space-y-1.5 p-2.5 rounded border border-accent-amber/40 bg-accent-amber-dim/15"
        >
          <div className="text-2xs text-text-secondary">
            <span className="text-accent-amber font-semibold">⚠ {openSuggestionsConfirmLabel(openSug)}</span>
            {openSug.files.length > 0 && (
              <span className="text-text-muted">
                {" "}
                on <span className="font-mono text-text-secondary">{openSug.files.join(", ")}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleAction("approved", { bypassSuggestionGate: true })}
              disabled={submitting}
              data-testid="approve-anyway"
              className="px-2.5 py-1 text-2xs font-medium text-white bg-accent-amber rounded
                         hover:bg-accent-amber/85 disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
              title="Approve even though your suggestions are still open"
            >
              Approve anyway
            </button>
            <button
              onClick={() => setApproveConfirm(false)}
              disabled={submitting}
              className="text-2xs text-text-muted hover:text-text-secondary"
            >
              Keep reviewing
            </button>
          </div>
        </div>
      )}
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
            title="Respond, request changes, or reject — opens the full review panel"
          >
            {/* #193 E2 (M6) — verb-lexicon coherence: the slim bar now names the
                SAME cased verbs the expanded panel's buttons carry (Respond /
                Request changes / Reject), so one control doesn't advertise two
                different verb sets. */}
            Respond / Request changes / Reject…
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
          className="px-3 py-1.5 bg-accent-violet-strong text-white text-xs font-medium rounded
                     hover:bg-accent-violet-strong-hover disabled:bg-surface-elevated disabled:text-text-muted
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
            title={comment.trim() ? "Request changes — agent will redraft" : "Add a reason first"}
          >
            Request changes
          </button>
          <button
            onClick={beginReject}
            disabled={submitting || !comment.trim() || rejecting}
            className="px-2.5 py-1 text-2xs font-medium text-accent-red rounded border border-accent-red/30
                       hover:bg-accent-red-dim disabled:opacity-30 transition-all duration-[180ms] ease-out press-scale"
            title={
              !comment.trim()
                ? "Add a reason first"
                : suppressRejectConcept
                  // #193 E2 — a debrief reject is "redo this write-up", not a
                  // remembered rule: no cross-project stance is recorded.
                  ? "Reject — asks for a redo of this digest (records no cross-project rule)"
                  : "Reject and remember this pattern across sessions"
            }
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
          future paraphrase gets caught — not just this artifact's title.
          #193 E2 — never shown when reject captures no stance (debrief):
          beginReject rejects in one step there, so this panel stays closed. */}
      {rejecting && !suppressRejectConcept && (
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
          {suppressRejectConcept
            ? "⌘⏎ on empty input approves · Reject / Request changes need a reason (redo the digest)"
            : "⌘⏎ on empty input approves · Reject / Revise need a reason (remembered across sessions)"}
        </div>
      )}
      </>
      )}
      </div>
    </>
  );
}
