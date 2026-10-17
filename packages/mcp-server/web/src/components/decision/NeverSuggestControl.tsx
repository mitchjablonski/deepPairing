import { useEffect, useRef, useState } from "react";
import { apiBase, safeFetch, sessionHeaders } from "../../lib/api";
import { useOfflineReason } from "../../hooks/useOfflineReason";
import { useUnsavedText } from "../../lib/unsavedText";

/**
 * #549 — the explicit per-option "Never suggest this".
 *
 * Picking one option no longer records the others as rejected stances (the
 * human's rule: only if they say so). This is how they say so, for ONE option:
 * it records that option through the never-suggest route, which writes the
 * same ledger row the old implicit path did, so the pre-flight gate blocks a
 * later re-proposal of it.
 *
 * Misclick-safe by construction: the first click only opens a confirm panel
 * (with an optional reason); nothing is written until "Remember as rejected".
 * Real buttons throughout, Escape cancels, Ctrl/⌘+Enter confirms. The confirm
 * is disabled while the tab is offline (#465/#487); the reason box stays
 * editable and registers with useUnsavedText so a Reload asks before
 * discarding it.
 */
export function NeverSuggestControl({
  decisionId,
  optionId,
  optionTitle,
  sessionId,
}: {
  decisionId: string;
  optionId: string;
  optionTitle: string;
  /** The session that OWNS the decision (F6 routing on merged views). */
  sessionId?: string;
}) {
  const offline = useOfflineReason();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  useUnsavedText(`never-suggest:${decisionId}:${optionId}`, reason);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Return focus to the opener when the panel closes without a write, so a
  // keyboard user isn't dropped at the top of the document.
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!open && refocus.current) {
      refocus.current = false;
      openerRef.current?.focus();
    }
  }, [open]);

  const cancel = () => {
    refocus.current = true;
    setOpen(false);
    setReason("");
    setError(null);
  };

  const confirm = async () => {
    if (offline || submitting) return; // refused offline (the button is disabled too)
    setSubmitting(true);
    setError(null);
    try {
      await safeFetch(
        `${apiBase()}/api/decisions/${encodeURIComponent(decisionId)}/options/${encodeURIComponent(optionId)}/never-suggest`,
        {
          method: "POST",
          headers: sessionHeaders(sessionId),
          body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}),
        },
      );
      setDone(true);
      setOpen(false);
      setReason("");
    } catch (err) {
      // Keep the panel (and the typed reason) so the human can retry.
      setError(err instanceof Error ? err.message : "Couldn't save that. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <span className="text-2xs text-accent-red" role="status">
        ✓ Remembered as rejected
      </span>
    );
  }

  if (!open) {
    return (
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Never suggest ${optionTitle}`}
        title="Remember this option as a rejected approach, so Claude doesn't propose it again in this project"
        className="px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-accent-red hover:bg-accent-red-dim/40 transition-colors"
      >
        Never suggest this
      </button>
    );
  }

  const reasonId = `never-suggest-reason-${decisionId}-${optionId}`;
  return (
    <div
      role="group"
      aria-label={`Never suggest ${optionTitle}`}
      className="mt-1.5 w-full p-2 bg-surface-elevated border border-border-default rounded-lg"
    >
      <label htmlFor={reasonId} className="block text-2xs text-text-muted mb-1.5">
        Remember “{optionTitle}” as rejected? Claude won't propose it again in this project. Why? (optional)
      </label>
      <textarea
        id={reasonId}
        rows={2}
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void confirm();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder="Reason (remembered across sessions)…"
        className="w-full px-2 py-1.5 bg-surface-secondary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none"
      />
      {error && (
        <p className="mt-1 text-2xs text-accent-red" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-1.5 mt-1.5 justify-end">
        <button
          type="button"
          onClick={cancel}
          className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          title={offline ?? undefined}
          onClick={() => void confirm()}
          disabled={submitting || !!offline}
          className="px-2 py-1 text-2xs text-text-inverse bg-accent-red hover:bg-accent-red/80 rounded press-scale disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Remember as rejected
        </button>
      </div>
    </div>
  );
}
