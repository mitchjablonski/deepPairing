import { useState } from "react";
import { useArtifactStore } from "../stores/artifact";
import { computePending } from "../lib/pending";

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
  const updateArtifactStatus = useArtifactStore((s) => s.updateArtifactStatus);
  // UX5 — dismissing marks a draft obsolete, which the API can't undo back to
  // draft, so require a two-step confirm instead of a one-click destructive ✕.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const { drafts, total } = computePending(artifacts);
  if (total === 0) return null;

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
              className={`px-1.5 py-0.5 rounded-r text-2xs border-l border-accent-amber/20 transition-colors ${
                confirmingId === a.id
                  ? "text-accent-amber font-semibold bg-accent-amber-dim"
                  : "text-accent-amber/70 hover:text-accent-amber hover:bg-accent-amber-dim/80"
              }`}
              title={confirmingId === a.id ? "Click again to dismiss (can't be undone)" : "Dismiss — overcome by new information"}
              aria-label={confirmingId === a.id ? `Confirm dismiss ${a.title}` : `Dismiss ${a.title}`}
            >
              {confirmingId === a.id ? "Dismiss?" : "✕"}
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
