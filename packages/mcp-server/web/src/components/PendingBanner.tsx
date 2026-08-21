import { useEffect, useState } from "react";
import { useArtifactStore } from "../stores/artifact";
import { computePending, isSinglePendingInView } from "../lib/pending";

/**
 * The "waiting for your review" banner. Driven by the shared computePending
 * selector (lib/pending) so it counts the SAME set as the cross-project badge —
 * draft reviewable artifacts that are genuinely YOUR turn. Human-asked questions
 * are NOT shown here: they're the agent's turn (TurnIndicator surfaces them as a
 * "waiting on the agent" badge), and a "waiting on you" banner you can't action
 * is just a nag.
 *
 * Every counted draft gets a quick "Dismiss" here (marks it obsolete), so an
 * abandoned draft can be cleared without opening the artifact and hunting for
 * the tertiary dismiss link.
 */
export function PendingBanner() {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const selectedArtifactId = useArtifactStore((s) => s.selectedArtifactId);
  const updateArtifactStatus = useArtifactStore((s) => s.updateArtifactStatus);
  // UX5 — dismissing marks a draft obsolete, which the API can't undo back to
  // draft, so require a two-step confirm instead of a one-click destructive ✕.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const { drafts, total } = computePending(artifacts);
  // J2b (#212) — lite-frame step-down: when the ONE pending draft is the card
  // already on screen, it IS the call to action (its own status badge + review
  // actions), so this banner would just restate what the card + the header count
  // pill already say. Suppress it. The shared predicate keeps this in lockstep
  // with the header-pill collapse in App (they can't disagree). The banner still
  // shows for 2+ pending and when the single pending draft is NOT selected (the
  // scent to reach it) — see isSinglePendingInView.
  const suppressed = isSinglePendingInView(artifacts, selectedArtifactId);

  // Review (LOW) — the suppression is an in-component early return, so this
  // instance never UNMOUNTS: a chip left in the armed "Dismiss?" state would
  // persist across a suppress → reappear cycle (select the draft to hide the
  // banner, deselect to bring it back), collapsing the two-step confirm to a
  // single click across a hidden interval. Disarm whenever we suppress, so the
  // banner always reappears with its chips reset (the onBlur reset can't fire —
  // an unmounted-by-return chip never blurs).
  useEffect(() => {
    if (suppressed) setConfirmingId(null);
  }, [suppressed]);

  if (total === 0 || suppressed) return null;

  return (
    <div className="px-3 py-1.5 bg-accent-amber-dim/50 border-b border-accent-amber/15 flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse shrink-0" />
      <span className="text-2xs text-accent-amber font-medium shrink-0">
        {total} item{total > 1 ? "s" : ""} waiting for you
      </span>
      <div className="flex gap-1 ml-auto items-center min-w-0 overflow-x-auto">
        {drafts.slice(0, 3).map((a) => (
          <span key={a.id} className="flex items-center bg-accent-amber-dim rounded shrink-0">
            <button
              onClick={() => selectArtifact(a.id)}
              className="px-2 py-0.5 text-accent-amber rounded-l text-2xs hover:bg-accent-amber-dim/80 transition-colors"
              title={a.title}
            >
              {a.title.slice(0, 28)}{a.title.length > 28 ? "…" : ""}
            </button>
            {/* Quick dismiss — clears an abandoned/moot draft without opening it.
                Two-step: first click asks to confirm (obsolete can't be undone). */}
            <button
              onClick={() => {
                if (confirmingId === a.id) {
                  // store rolls back + toasts on failure; swallow so a failed
                  // POST isn't an unhandled rejection (UX7d theme)
                  void updateArtifactStatus(a.id, "obsolete").catch(() => {});
                  setConfirmingId(null);
                } else {
                  setConfirmingId(a.id);
                }
              }}
              onBlur={() => setConfirmingId((id) => (id === a.id ? null : id))}
              // Q4 (round-12 UX #3) — the waiting strip's measured AA failure.
              // The sibling "+N more" comment below already names this class,
              // but the dismiss chip kept its /70: composited it lands at
              // #a88743 on the chip's own amber-dim fill = 3.13:1 light /
              // 3.58:1 dark, both under AA, on the control that DESTROYS a
              // draft. The /70 only bought a rest-vs-hover distinction the
              // hover BACKGROUND already carries — drop it and the same chip
              // reads 5.85:1 light / 5.61:1 dark.
              className={`px-1.5 py-0.5 rounded-r text-2xs border-l border-accent-amber/20 transition-colors ${
                confirmingId === a.id
                  ? "text-accent-amber font-semibold bg-accent-amber-dim"
                  : "text-accent-amber hover:bg-accent-amber-dim/80"
              }`}
              title={confirmingId === a.id ? "Click again to dismiss (can't be undone)" : "Dismiss — overcome by new information"}
              aria-label={confirmingId === a.id ? `Confirm dismiss ${a.title}` : `Dismiss ${a.title}`}
            >
              {confirmingId === a.id ? "Dismiss?" : "✕"}
            </button>
          </span>
        ))}
        {/* #192 (usability L8) — the chip strip is capped at 3, so with 5+
            pending the debrief/explainer (created last, at the end of a run) fell
            off silently. A quiet "+N more" jumps to the first hidden draft
            (advancing into the tail like the n-key), and its title lists them. */}
        {drafts.length > 3 && (
          <button
            onClick={() => selectArtifact(drafts[3]!.id)}
            // Sits on the chip background (like the sibling chips) rather than the
            // darker banner surface so the small text keeps AA contrast (a bare
            // text-accent-amber/70 on the banner bg fails 4.5:1 — caught by axe).
            className="px-2 py-0.5 text-2xs text-accent-amber bg-accent-amber-dim rounded shrink-0 hover:bg-accent-amber-dim/80 transition-colors"
            title={`${drafts.length - 3} more waiting: ${drafts.slice(3).map((d) => d.title).join(", ")}`}
            aria-label={`${drafts.length - 3} more waiting — jump to the next`}
          >
            +{drafts.length - 3} more
          </button>
        )}
      </div>
    </div>
  );
}
