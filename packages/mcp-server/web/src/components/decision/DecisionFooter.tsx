import type { Dispatch, SetStateAction } from "react";
import type { DecisionOption } from "./types";

interface DecisionFooterProps {
  options: DecisionOption[];
  focusedIndex: number;
  /** Artifact id — gates the "None of these fit" send-back trigger. */
  artifactId?: string;
  stakes?: "low" | "medium" | "high";
  showSendBack: boolean;
  setShowSendBack: Dispatch<SetStateAction<boolean>>;
  sendBackText: string;
  setSendBackText: (v: string) => void;
  submitSendBack: () => void;
  sendBackSent: boolean;
  /** #169 (F1/F2) — the HARD-reject gesture ("wrong question"), distinct from
   *  the send-back ("none of these fit"). Arms the gate against the framing. */
  showReject: boolean;
  setShowReject: Dispatch<SetStateAction<boolean>>;
  rejectText: string;
  setRejectText: (v: string) => void;
  rejectConcept: string;
  setRejectConcept: (v: string) => void;
  submitReject: () => void;
  rejectSent: boolean;
  showReasoning: boolean;
  setShowReasoning: Dispatch<SetStateAction<boolean>>;
  reasoning: string;
  setReasoning: (v: string) => void;
  /** Selecting from the reasoning input's Enter key — commits the focused option. */
  onSelect: (optionId: string) => void;
  predictOptIn: boolean;
  setPredictOptIn: Dispatch<SetStateAction<boolean>>;
}

export function DecisionFooter({
  options,
  focusedIndex,
  artifactId,
  stakes,
  showSendBack,
  setShowSendBack,
  sendBackText,
  setSendBackText,
  submitSendBack,
  sendBackSent,
  showReject,
  setShowReject,
  rejectText,
  setRejectText,
  rejectConcept,
  setRejectConcept,
  submitReject,
  rejectSent,
  showReasoning,
  setShowReasoning,
  reasoning,
  setReasoning,
  onSelect,
  predictOptIn,
  setPredictOptIn,
}: DecisionFooterProps) {
  return (
    /* X11 — escape hatches grouped under one footer instead of two
       stacked bordered blocks. Pre-X11 "Send back" and "Why this choice"
       each rendered with their own border + spacing, competing with the
       option grid for visual weight. Now they share a single muted
       footer; only the active composer expands above the row. They're
       mutually exclusive in practice — opening one closes the other. */
    <div className="mt-3 pt-3 border-t border-accent-violet/15">
      {showSendBack && !sendBackSent && (
        <div className="space-y-2 mb-2">
          <label className="block text-2xs text-text-muted">
            What should change about the options? (the agent will revise the set, not just answer)
          </label>
          <textarea
            rows={3}
            autoFocus
            value={sendBackText}
            onChange={(e) => setSendBackText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitSendBack();
              }
              if (e.key === "Escape") {
                setShowSendBack(false);
                setSendBackText("");
              }
            }}
            placeholder="e.g. all 4 are matchers — what about a hybrid? Or: option B should use Y instead of X…"
            className="w-full px-2.5 py-1.5 bg-surface-secondary border border-accent-amber/30 rounded text-xs text-text-primary
                       placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-amber resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={submitSendBack}
              disabled={!sendBackText.trim()}
              className="px-3 py-1 text-xs font-medium bg-accent-amber text-text-inverse rounded
                         hover:bg-accent-amber/80 disabled:opacity-50 transition-colors press-scale"
            >
              ↻ Send back for revision
            </button>
            <button
              onClick={() => { setShowSendBack(false); setSendBackText(""); }}
              className="px-2.5 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <span className="ml-auto text-2xs text-text-muted italic">⌘⏎ to send</span>
          </div>
        </div>
      )}

      {showReject && !rejectSent && (
        <div className="space-y-2 mb-2 p-2.5 rounded border border-accent-red/30 bg-accent-red-dim/15">
          <label className="block text-2xs text-text-muted">
            Why is this the wrong question? The agent will remember not to
            re-propose this framing.
          </label>
          <textarea
            rows={2}
            autoFocus
            value={rejectText}
            onChange={(e) => setRejectText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitReject();
              }
              if (e.key === "Escape") {
                setShowReject(false);
                setRejectText("");
                setRejectConcept("");
              }
            }}
            placeholder="e.g. we don't need a cache at all here — this is premature optimization"
            className="w-full px-2.5 py-1.5 bg-surface-secondary border border-accent-red/30 rounded text-xs text-text-primary
                       placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-red resize-none"
          />
          <input
            type="text"
            value={rejectConcept}
            onChange={(e) => setRejectConcept(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); submitReject(); }
              if (e.key === "Escape") { setShowReject(false); setRejectText(""); setRejectConcept(""); }
            }}
            placeholder="Name the pattern you're rejecting (optional — your cross-project memory key)"
            aria-label="Name the pattern you're rejecting"
            className="w-full px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                       placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-red"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={submitReject}
              disabled={!rejectText.trim()}
              className="px-3 py-1 text-xs font-medium bg-accent-red text-white rounded
                         hover:bg-accent-red/80 disabled:opacity-50 transition-colors press-scale"
            >
              ✕ Reject &amp; remember
            </button>
            <button
              onClick={() => { setShowReject(false); setRejectText(""); setRejectConcept(""); }}
              className="px-2.5 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <span className="ml-auto text-2xs text-text-muted italic">⌘⏎ to reject</span>
          </div>
        </div>
      )}

      {showReasoning && (
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            placeholder="Why — becomes the 'don't propose these' reason for rejected options"
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const focusedOption = options[focusedIndex];
                if (focusedOption) onSelect(focusedOption.id);
              }
              if (e.key === "Escape") {
                setShowReasoning(false);
                setReasoning("");
              }
            }}
            autoFocus
            className="flex-1 px-3 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                       placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue"
          />
          <button
            onClick={() => { setShowReasoning(false); setReasoning(""); }}
            className="text-xs text-text-muted hover:text-text-secondary"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Tertiary affordance row — both triggers live here as muted
          text links. The "decision sent back" indicator displaces them
          once revision is requested (the user already escaped). */}
      {rejectSent ? (
        <div className="flex items-center gap-2 text-2xs text-accent-red">
          <span aria-hidden>✕</span>
          <span>
            You rejected this framing — the agent won't re-propose it. Your
            reason is remembered across sessions.
          </span>
        </div>
      ) : sendBackSent ? (
        <div className="flex items-center gap-2 text-2xs text-accent-amber">
          <span aria-hidden>↻</span>
          <span>
            Revision requested — the agent will post a revised set of options.
            You can still pick from these if you change your mind.
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-3 flex-wrap text-2xs text-text-muted">
          {!showReasoning && (
            <button
              onClick={() => { setShowReasoning(true); setShowSendBack(false); }}
              className="hover:text-accent-blue transition-colors"
              title="The reason you pick gets recorded as the why for every rejected option"
            >
              + Add reasoning <span className="opacity-60">(remembered across sessions)</span>
            </button>
          )}
          {/* FF9 — opt-in prediction capture toggle on high-stakes
              decisions. When ON, clicking an option enters the
              predicting phase (confidence + outcome inputs) before
              submitting; when OFF (default), the pick submits
              immediately. Surfaces only when stakes='high'. */}
          {stakes === "high" && (
            <button
              onClick={() => setPredictOptIn((v) => !v)}
              className={`transition-colors ${predictOptIn ? "text-accent-violet" : "hover:text-accent-violet"}`}
              title="Capture confidence + predicted outcome on this pick — for calibration over time"
              aria-pressed={predictOptIn}
            >
              {predictOptIn ? "✓ Predicting outcome" : "+ Capture prediction with my pick"}
            </button>
          )}
          {artifactId && !showSendBack && (
            <button
              onClick={() => { setShowSendBack(true); setShowReasoning(false); setShowReject(false); }}
              className="hover:text-accent-amber transition-colors"
              title="None of these options fit — send the decision back to the agent for a revised option set"
              aria-label="Send decision back for revised options"
            >
              ↻ None of these fit
            </button>
          )}
          {artifactId && !showReject && (
            <button
              onClick={() => { setShowReject(true); setShowSendBack(false); setShowReasoning(false); }}
              className="hover:text-accent-red transition-colors"
              title="Reject this whole framing — you don't want any version of this. Remembered so the agent can't re-propose the same question."
              aria-label="Reject this framing — wrong question"
            >
              ✕ Reject — wrong question
            </button>
          )}
        </div>
      )}
    </div>
  );
}
