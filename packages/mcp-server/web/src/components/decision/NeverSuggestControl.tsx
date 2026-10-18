import { useEffect, useRef, useState } from "react";
import type { DecisionOption } from "@deeppairing/shared";
import { apiBase, safeFetch, sessionHeaders } from "../../lib/api";
import { useOfflineReason } from "../../hooks/useOfflineReason";
import { useUnsavedText } from "../../lib/unsavedText";
import { useLedgerStore } from "../../stores/ledger";

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
/** A session-ledger rejection row, as GET /api/memory returns it. */
export interface RememberedRejection {
  description: string;
  concept?: string;
  sourceArtifactId?: string;
}

/**
 * #549 (Fable LOW) — the remembered state survives a reload: read the session
 * ledger the daemon already serves (GET /api/memory, no new endpoint) so an
 * option that already has a rejection row renders "Remembered as rejected"
 * instead of offering the control again. Fail-soft: an unreachable or odd
 * response just means nothing is pre-marked.
 */
export function useRememberedRejections(sessionId?: string) {
  const [rows, setRows] = useState<RememberedRejection[]>([]);
  const ledgerVersion = useLedgerStore((s) => s.version);
  const generation = useRef(0);
  useEffect(() => {
    const ac = new AbortController();
    const requestGeneration = ++generation.current;
    (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/memory`, { headers: sessionHeaders(sessionId), signal: ac.signal });
        if (!res?.ok) return;
        const body = (await res.json()) as { rejectedApproaches?: unknown } | null;
        if (!Array.isArray(body?.rejectedApproaches)) return;
        const list = body.rejectedApproaches;
        const parsed = list.filter(
          (r): r is RememberedRejection => !!r && typeof (r as RememberedRejection).description === "string",
        );
        if (!ac.signal.aborted && requestGeneration === generation.current) setRows(parsed);
      } catch {
        /* fail-soft — nothing pre-marked */
      }
    })();
    return () => { ac.abort(); };
  }, [sessionId, ledgerVersion]);
  // A confirmed write shares the same state as a memory read. Invalidate any
  // older in-flight read so it cannot erase the just-recorded rejection; the
  // next existing Ledger refresh can then reflect a later local retirement.
  const remember = (row: RememberedRejection) => {
    generation.current++;
    setRows((current) => [...current.filter((r) => r.description !== row.description), row]);
  };
  return { rows, remember };
}

/** Does the ledger already hold a rejection for this option of this decision?
 *  Matches the exact key the never-suggest route writes (`${label}: ${title}`,
 *  label = the card's short title else its context), or — scoped to this card's
 *  artifact — the option's concept key. A row an older build auto-recorded has
 *  the same key, and it DOES gate, so showing it as remembered is the truth. */
export function isOptionRemembered(
  rows: RememberedRejection[],
  params: { label: string; option: Pick<DecisionOption, "title" | "description" | "concept">; artifactId?: string },
): boolean {
  const key = `${params.label.trim()}: ${params.option.title}`;
  const concept = params.option.concept?.name ?? params.option.description;
  return rows.some(
    (r) =>
      r.description === key ||
      (!!params.artifactId && r.sourceArtifactId === params.artifactId && !!concept && r.concept === concept),
  );
}

/** Opens the Ledger (the place a stance is retired), focused on this one. */
function openLedgerFor(concept: string) {
  window.dispatchEvent(
    new CustomEvent("dp:open-your-taste", { detail: { initialTab: "ledger", highlightConcept: concept } }),
  );
}

export function NeverSuggestControl({
  decisionId,
  optionId,
  optionTitle,
  ledgerConcept,
  sessionId,
  remembered = false,
  onRecorded,
}: {
  decisionId: string;
  optionId: string;
  optionTitle: string;
  /** The ledger key the "Retire it in the Ledger" link highlights. */
  ledgerConcept?: string;
  /** The session that OWNS the decision (F6 routing on merged views). */
  sessionId?: string;
  /** Already in the ledger (derived from GET /api/memory) — render the result state. */
  remembered?: boolean;
  /** The parent keeps confirmed writes and refreshed memory in one state. */
  onRecorded: () => void;
}) {
  const offline = useOfflineReason();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  useUnsavedText(`never-suggest:${decisionId}:${optionId}`, reason);
  const [submitting, setSubmitting] = useState(false);
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
      onRecorded();
      setOpen(false);
      setReason("");
    } catch (err) {
      // Keep the panel (and the typed reason) so the human can retry.
      setError(err instanceof Error ? err.message : "Couldn't save that. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (remembered) {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs" role="status">
        <span className="text-accent-red">✓ Remembered as rejected</span>
        <button
          type="button"
          onClick={() => openLedgerFor(ledgerConcept ?? optionTitle)}
          className="text-text-muted underline underline-offset-2 hover:text-text-primary cursor-pointer"
        >
          Retire it in the Ledger
        </button>
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
        className="px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-accent-red hover:bg-accent-red-dim/40 transition-colors cursor-pointer"
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
        Remember “{optionTitle}” as rejected? Claude won't propose it again in this project (you can retire it later in the Ledger). Why? (optional)
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
          className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          title={offline ?? undefined}
          onClick={() => void confirm()}
          disabled={submitting || !!offline}
          className="px-2 py-1 text-2xs text-text-inverse bg-accent-red hover:bg-accent-red/80 rounded press-scale cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Remember as rejected
        </button>
      </div>
    </div>
  );
}
