import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ProposalSnapshot } from "@deeppairing/shared";
import { useAllowOnceStore, type AllowOnceRequest } from "../stores/allowOnce";
import { usePreflightBlockStore } from "../stores/preflightBlocks";
import { useToastStore } from "../stores/toast";
import { announce } from "../stores/announce";
import { useOfflineReason } from "../hooks/useOfflineReason";
import { useUnsavedText } from "../lib/unsavedText";
import { computeLineDiff, collapseDiff } from "../lib/diff";
import {
  REASON_HINT,
  SCOPE_SENTENCE,
  fetchExceptionPreview,
  announceGrantOnce,
  terminalAllowanceText,
  ineligibleText,
  postGrant,
  preconditionFooter,
  preconditionLine,
  reasonIsValid,
  type ExceptionPreview,
} from "../lib/stanceException";

/**
 * #470 slice 2 (§3a) — the "Allow this proposal once" dialog.
 *
 * Semantics: role=dialog + aria-modal, labelled by a heading that NAMES the
 * stance, described by the scope sentence. Focus starts on the heading (so a
 * screen reader announces what is being allowed before the first Tab reaches
 * the reason), is trapped inside, and returns to the opener on close. Tab
 * order: preview → reason → Allow once → Cancel. Enter in the reason confirms
 * only when the reason is valid; Esc cancels and sends nothing. A refusal
 * (503/409/…) keeps the dialog open with the message in a role=alert region.
 *
 * The preview is the daemon's OWN record of the block (the same one a grant
 * binds to) — never the block-log file — so what you see is what you allow.
 */
export function AllowOnceDialogHost() {
  const request = useAllowOnceStore((s) => s.request);
  if (!request) return null;
  return <AllowOnceDialog key={request.blockId} request={request} />;
}

function AllowOnceDialog({ request }: { request: AllowOnceRequest }) {
  const close = useAllowOnceStore((s) => s.close);
  const offline = useOfflineReason();
  const headingId = useId();
  const scopeId = useId();
  const hintId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [preview, setPreview] = useState<ExceptionPreview | null | "loading">("loading");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHint, setShowHint] = useState(false);
  // #487 pattern — what you typed is kept while offline, and the one Reload
  // this app offers asks before discarding it.
  useUnsavedText(`allow-once:${request.blockId}`, reason);

  useEffect(() => {
    let live = true;
    void fetchExceptionPreview(request.blockId).then((p) => { if (live) setPreview(p); });
    return () => { live = false; };
  }, [request.blockId]);

  // Initial focus on the heading; on close, back to the opener.
  useEffect(() => {
    headingRef.current?.focus();
    const opener = request.returnFocusTo;
    const toastId = request.toastId;
    if (toastId) useToastStore.getState().pause(toastId);
    return () => {
      const toasts = useToastStore.getState();
      if (toastId) toasts.resume(toastId);
      // Back to the opener; if it's gone (the toast now shows its receipt),
      // to the toast itself as a stable anchor. Neither is the reader
      // hovering, so this focus must not hold the toast (#501 review, Fable).
      const anchor = toastId ? document.querySelector<HTMLElement>(`[data-toast-id="${toastId}"]`) : null;
      const target = opener && opener.isConnected ? opener : anchor;
      if (!target) return;
      if (toastId && anchor?.contains(target)) toasts.skipNextFocusHold(toastId);
      target.focus();
    };
  }, [request]);

  // #501 round 4 (Sol P2) — a block that already carries an allowance can't
  // be allowed again from here: the preview says what state it's in instead.
  const existingState = preview !== "loading" ? preview?.allowance?.state : undefined;
  const eligible = preview !== "loading" && !!preview?.eligible && !!preview.snapshot && !existingState;
  const valid = reasonIsValid(reason);
  const canConfirm = eligible && valid && !offline && !busy;

  const confirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    const res = await postGrant(request.blockId, reason);
    // #501 review (Luna P2) — the request this dialog was opened for; a newer
    // dialog (another block) must never be closed by this completion.
    const stillCurrent = useAllowOnceStore.getState().request === request;
    if (!res.ok) {
      if (stillCurrent) {
        setBusy(false);
        setError(res.message);
      }
      return;
    }
    // Server values only (#501 review): the daemon's receipt and seenAt. If
    // the response lacked them, the daemon's broadcast applies them instead.
    if (res.receipt) usePreflightBlockStore.getState().applyReceipt(request.blockId, res.receipt, res.seenAt);
    // #501 round 4 (Sol P2) — an idempotent answer can carry a TERMINAL
    // allowance (it moved on since the preview): say so, announce nothing,
    // and keep the dialog open on the truth.
    const state = res.receipt?.state ?? res.allowance.state;
    if (state !== "allowed") {
      if (stillCurrent) {
        setBusy(false);
        setError(terminalAllowanceText(state));
      }
      return;
    }
    // One announcement per allowance, whichever of this result and the
    // daemon's broadcast arrives first (#501 review).
    announceGrantOnce(res.allowance.id, request.concept, { blockId: request.blockId });
    if (stillCurrent) close();
  };

  // Focus trap over the dialog's own controls (jsdom-safe: no layout reads).
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      // #501 review (Luna P2) — a dispatched grant can't be cancelled, so
      // Esc doesn't pretend to: it does nothing until the daemon answers.
      if (!busy) close();
      return;
    }
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>("[data-trap]")).filter(
      (n) => !(n as HTMLButtonElement).disabled,
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables.at(-1)!;
    const current = document.activeElement as HTMLElement | null;
    const idx = current ? focusables.indexOf(current) : -1;
    e.preventDefault();
    if (e.shiftKey) (idx <= 0 ? last : focusables[idx - 1]!).focus();
    else (idx === -1 || current === last ? first : focusables[idx + 1]!).focus();
  };

  const onReasonKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (canConfirm) void confirm();
    else if (!valid) {
      setShowHint(true);
      announce(REASON_HINT);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" data-allow-once-dialog="">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={scopeId}
        data-testid="allow-once-dialog"
        onKeyDown={onKeyDown}
        className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-lg border border-border-default bg-surface-elevated shadow-2xl"
      >
        <div className="px-4 pt-4 pb-2 space-y-1">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-text-primary outline-none">
            Allow one proposal past '{request.concept}'
          </h2>
          <p id={scopeId} className="text-2xs text-text-secondary">{SCOPE_SENTENCE}</p>
        </div>

        <div
          data-trap=""
          tabIndex={0}
          role="region"
          aria-label="What will be created"
          data-testid="allow-once-preview"
          className="mx-4 flex-1 min-h-0 overflow-auto rounded border border-border-default bg-surface-primary p-2 text-2xs"
        >
          {preview === "loading" ? (
            <div className="text-text-muted">Loading what would be created…</div>
          ) : !preview ? (
            <div className="text-text-secondary">{ineligibleText("session_ended")}</div>
          ) : existingState ? (
            <div className="text-text-secondary" data-testid="allow-once-existing">
              {existingState === "allowed" ? "This proposal is already allowed once, and Claude can retry it." : terminalAllowanceText(existingState)}
            </div>
          ) : !eligible ? (
            <div className="text-text-secondary" data-testid="allow-once-ineligible">{ineligibleText(preview.ineligibleReason)}</div>
          ) : (
            <>
              <div className="font-semibold text-text-secondary uppercase tracking-wide text-[10px] mb-1">What will be created (all of this is covered)</div>
              {(preview.preconditions ?? []).map((p, i) => (
                <div key={i} className="text-text-secondary mb-1" data-testid="allow-once-precondition">{preconditionLine(p)}</div>
              ))}
              <SnapshotPreview snapshot={preview.snapshot!} />
              <div className="mt-2 text-text-muted">{preconditionFooter(preview.preconditions ?? [])}</div>
            </>
          )}
        </div>

        <div className="px-4 pt-3 space-y-1">
          <label className="block text-2xs font-medium text-text-secondary" htmlFor={`${headingId}-reason`}>
            Why is this one fine? (shown with the allowance)
          </label>
          <textarea
            id={`${headingId}-reason`}
            data-trap=""
            value={reason}
            onChange={(e) => { setReason(e.target.value); if (showHint) setShowHint(false); }}
            onKeyDown={onReasonKey}
            rows={2}
            maxLength={400}
            aria-invalid={showHint && !valid ? true : undefined}
            aria-describedby={hintId}
            className="w-full rounded border border-border-default bg-surface-primary px-2 py-1 text-xs text-text-primary"
          />
          <div id={hintId} className={`text-[10px] ${showHint && !valid ? "text-accent-red" : "text-text-muted"}`}>{REASON_HINT}</div>
          <div role="alert" data-testid="allow-once-error" className="text-2xs text-accent-red min-h-[1em]">{error}</div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 pb-4 pt-1">
          <button
            type="button"
            data-trap=""
            onClick={() => void confirm()}
            disabled={!canConfirm}
            title={offline ?? (!eligible ? "This block can't be allowed once." : !valid ? REASON_HINT : undefined)}
            className="min-h-[32px] min-w-[32px] px-3 rounded bg-accent-violet text-white text-xs font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Allowing…" : "Allow once"}
          </button>
          <button
            type="button"
            data-trap=""
            onClick={close}
            disabled={busy}
            title={busy ? "The request is already on its way; it can't be cancelled now." : undefined}
            className="min-h-[32px] min-w-[32px] px-3 rounded border border-border-default text-xs text-text-secondary cursor-pointer hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** The effective snapshot rendered in the artifact's own shape. */
export function SnapshotPreview({ snapshot }: { snapshot: ProposalSnapshot }) {
  const c = snapshot.content as Record<string, unknown>;
  const rows = useMemo(() => {
    if (snapshot.type !== "code_change") return null;
    return collapseDiff(computeLineDiff(String(c.before ?? ""), String(c.after ?? "")));
  }, [snapshot.type, c.before, c.after]);
  if (snapshot.type === "code_change" && rows) {
    return (
      <div data-testid="allow-once-diff">
        <div className="font-mono text-text-primary">{String(c.filePath ?? "")} <span className="text-text-muted">({String(c.changeType ?? "")})</span></div>
        <pre className="mt-1 font-mono text-[11px] leading-snug whitespace-pre-wrap">
          {rows.map((r, i) =>
            r.type === "gap" ? (
              <div key={i} className="text-text-muted">⋯ {r.count} unchanged line{r.count === 1 ? "" : "s"}</div>
            ) : (
              <div key={i} className={r.type === "added" ? "text-accent-green" : r.type === "removed" ? "text-accent-red" : "text-text-secondary"}>
                {r.type === "added" ? "+ " : r.type === "removed" ? "- " : "  "}{r.content}
              </div>
            ))}
        </pre>
        {typeof c.reasoning === "string" && <div className="mt-1 text-text-secondary">{c.reasoning}</div>}
      </div>
    );
  }
  if (snapshot.type === "decision" && Array.isArray(c.options)) {
    return (
      <div data-testid="allow-once-decision">
        <div className="font-semibold text-text-primary">{snapshot.title}</div>
        {typeof c.context === "string" && <div className="text-text-secondary">{c.context}</div>}
        <ul className="mt-1 space-y-1">
          {(c.options as Array<Record<string, unknown>>).map((o, i) => (
            <li key={i}>
              <div className="font-medium text-text-primary">{String(o.title ?? "")}</div>
              {typeof o.description === "string" && <div className="text-text-secondary">{o.description}</div>}
              {Array.isArray(o.pros) && o.pros.length > 0 && <div className="text-accent-green">Pros: {(o.pros as string[]).join("; ")}</div>}
              {Array.isArray(o.cons) && o.cons.length > 0 && <div className="text-accent-red">Cons: {(o.cons as string[]).join("; ")}</div>}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div data-testid="allow-once-generic">
      <div className="font-semibold text-text-primary">{snapshot.title}</div>
      <pre className="mt-1 font-mono text-[11px] whitespace-pre-wrap text-text-secondary">{JSON.stringify(c, null, 2)}</pre>
    </div>
  );
}
