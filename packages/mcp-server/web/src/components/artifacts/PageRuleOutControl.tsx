import { useEffect, useRef, useState } from "react";
import type { Comment, HtmlAnchor } from "@deeppairing/shared";
import { pageRuleOutKey } from "@deeppairing/shared";
import { apiBase, safeFetch, sessionHeaders } from "../../lib/api";
import { useOfflineReason } from "../../hooks/useOfflineReason";
import { useUnsavedText } from "../../lib/unsavedText";
import { useArtifactStore } from "../../stores/artifact";

/**
 * #680 slice 4 — "Rule this out" for the spot selected on a page.
 *
 * Records a rejected stance from the anchored text, with your reason, so the
 * gate refuses a later page (present_page, revise, or a watched-file save)
 * that contains it. The page itself stays under review. The phrase shown is
 * the exact one the server records (pageRuleOutKey is shared).
 *
 * Misclick-safe like "Never suggest this": the first click only opens a
 * confirm panel inline (below the composer, never over it); nothing is written
 * until "Rule it out", which stays disabled until you've typed a reason (a
 * stance is human-authored, so the reason is required and never composed).
 * Escape cancels, Ctrl/⌘+Enter confirms, offline disables the confirm.
 *
 * Security: an anchor from the frame only pre-targets this control. The
 * stance is created only by this explicit submit in the parent UI.
 */
export function PageRuleOutControl({
  artifactId,
  anchor,
  ruledOut,
}: {
  artifactId: string;
  anchor: HtmlAnchor;
  /** The phrase already ruled out at this spot (from its rule-out comment), if any. */
  ruledOut?: string;
}) {
  const offline = useOfflineReason();
  const phrase = pageRuleOutKey(anchor.quote);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  useUnsavedText(`page-rule-out:${artifactId}:${anchor.locator}`, reason);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordedHere, setRecorded] = useState<string | null>(null);
  const recorded = recordedHere ?? ruledOut ?? null;

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

  const trimmed = reason.trim();
  const confirm = async () => {
    if (offline || submitting || !trimmed || !phrase) return;
    setSubmitting(true);
    setError(null);
    try {
      const owner = useArtifactStore.getState().owningSession(artifactId);
      const res = await safeFetch(`${apiBase()}/api/artifacts/${encodeURIComponent(artifactId)}/rule-out`, {
        method: "POST",
        headers: sessionHeaders(owner),
        body: JSON.stringify({ htmlAnchor: anchor, reason: trimmed }),
      });
      let body: { description?: string; comment?: Comment } | null = null;
      try { body = await res.json(); } catch { /* the WS echo still delivers the comment */ }
      if (body?.comment?.id) useArtifactStore.getState().addComment(body.comment);
      setRecorded(body?.description ?? phrase);
      setOpen(false);
      setReason("");
    } catch (err) {
      // Keep the panel and the typed reason so you can adjust and retry.
      setError(err instanceof Error ? err.message : "Couldn't save that. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (recorded) {
    return (
      <p className="text-2xs text-accent-red" role="status" data-testid="page-rule-out-recorded">
        ✓ Ruled out “{recorded}”. Claude won't present a page containing it again in this project. You can retire it in the Ledger.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
        disabled={!phrase}
        title={
          phrase
            ? "Remember this text as a rejected approach, so Claude doesn't present it again in this project"
            : "This spot has too little text to rule out. Select the words you want gone."
        }
        className="px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-accent-red hover:bg-accent-red-dim/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Rule this out
      </button>
    );
  }

  const reasonId = `page-rule-out-reason-${artifactId}`;
  return (
    <div
      role="group"
      aria-label="Rule this out"
      className="w-full p-2 bg-surface-secondary border border-accent-red/30 rounded-lg"
      data-testid="page-rule-out-panel"
    >
      <label htmlFor={reasonId} className="block text-2xs text-text-muted mb-1.5">
        Rule out “<span className="text-text-primary">{phrase}</span>”? Claude won't present a page containing it again in
        this project, and the page stays under review (you can retire the stance later in the Ledger). Why are you ruling
        it out? (required)
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
        placeholder="Your reason (Claude sees it when the gate refuses this text)…"
        className="w-full px-2 py-1.5 bg-surface-primary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none"
      />
      {error && (
        <p className="mt-1 text-2xs text-accent-red" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-1.5 mt-1.5 justify-end">
        <button type="button" onClick={cancel} className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary cursor-pointer">
          Cancel
        </button>
        <button
          type="button"
          title={offline ?? (trimmed ? undefined : "Say why first")}
          onClick={() => void confirm()}
          disabled={submitting || !!offline || !trimmed}
          className="px-2 py-1 text-2xs text-text-inverse bg-accent-red hover:bg-accent-red/80 rounded press-scale cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Rule it out
        </button>
      </div>
    </div>
  );
}
