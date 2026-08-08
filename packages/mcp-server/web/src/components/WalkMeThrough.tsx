import { useState } from "react";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { useReplayStore } from "../stores/replay";
import { useToastStore } from "../stores/toast";
import { noAgentLive } from "../lib/liveness";

/**
 * O2 (#230) — the "Walk me through this" affordance. The round-10 review found
 * the explainer BUILT-NOT-DELIVERED: pull-only via prose, ZERO organic
 * invocations, because nothing is a CTA for the INITIAL invocation. This is that
 * CTA — a one-click, in-front-of-you-mid-review button that emits a SCOPED
 * "explain" REQUEST on the EXISTING request pipe (G1's composer → /api/requests →
 * the check_feedback request lane → linkServedRequest). It is a NEW ENTRY POINT
 * to that pipe, not new plumbing: an "explain"-intent request is exactly what
 * present_explainer serves, and the served-linkage flips the composer pip when
 * the agent responds with a present_explainer carrying servedRequestId.
 *
 * Quiet by design (a muted text link, never competing with the review actions),
 * keyboard-accessible (a plain <button>), themed via semantic tokens.
 */

/** Build the scoped instruction a "Walk me through" click emits. Exported +
 *  pure so it can be unit-tested and so the changeset/debrief entry points can't
 *  drift on how they phrase the ask. The text is a clear instruction the agent
 *  acts on with a present_explainer scoped to the given target. */
export function buildWalkMeThroughRequest(
  scope:
    | { kind: "file"; filePath: string }
    | { kind: "hunk"; filePath: string; lineStart: number; lineEnd: number }
    | { kind: "needs-eyes"; what: string; why?: string; hasArtifactRef?: boolean },
): string {
  if (scope.kind === "file") {
    return (
      `Walk me through how ${scope.filePath} works — respond with a present_explainer ` +
      `scoped to this file: what it does, how the pieces fit together, and anything I should watch for.`
    );
  }
  if (scope.kind === "hunk") {
    return (
      `Walk me through the change to ${scope.filePath} at lines ${scope.lineStart}–${scope.lineEnd} ` +
      `— respond with a present_explainer scoped to this hunk: what it does and why.`
    );
  }
  const target = scope.hasArtifactRef ? "the linked artifact" : "this";
  const whyClause = scope.why ? ` (${scope.why})` : "";
  return (
    `Walk me through "${scope.what}"${whyClause} — respond with a present_explainer scoped to ${target}: ` +
    `help me understand what to look at and why it matters.`
  );
}

export function WalkMeThroughButton({
  requestText,
  ariaLabel,
  label = "Walk me through this",
  className,
}: {
  /** The scoped instruction to emit — build with buildWalkMeThroughRequest. */
  requestText: string;
  /** Accessible name (the surrounding context, e.g. the file path or item). */
  ariaLabel: string;
  label?: string;
  className?: string;
}) {
  const submitRequest = useArtifactStore((s) => s.submitRequest);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const replayActive = useReplayStore((s) => s.active);
  const pushToast = useToastStore((s) => s.push);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // A request emitted during replay would land on the wrong (historical)
  // session, and submitRequest refuses it anyway — so the affordance is withheld.
  if (replayActive) return null;

  const onClick = async () => {
    if (sending) return;
    setSending(true);
    try {
      await submitRequest(requestText, "explain");
      setSent(true);
      setTimeout(() => setSent(false), 2500);
      // Liveness-branched confirmation — the same predicate the request composer
      // uses, so the two surfaces can't disagree about whether an agent is live.
      if (noAgentLive(activeSessions)) {
        pushToast({
          kind: "info",
          title: "Saved — Claude will walk you through it when the session resumes",
          body: "No agent is live. The request is queued in the Ask-Claude row with a resume prompt.",
        });
      } else {
        pushToast({
          kind: "success",
          title: "Sent to Claude",
          body: "It'll walk you through this on its next check-in (about every 30s while working).",
        });
      }
    } catch {
      /* store rolled back + toasted the error */
    } finally {
      setSending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={sending}
      data-testid="walk-me-through"
      aria-label={`Walk me through ${ariaLabel}`}
      title={`Ask Claude to walk you through ${ariaLabel} — a scoped explainer`}
      className={`inline-flex items-center gap-1 text-2xs font-medium text-text-muted hover:text-accent-blue
                  focus-visible:text-accent-blue focus-visible:outline-none focus-visible:ring-1
                  focus-visible:ring-accent-blue rounded px-1 py-0.5 transition-colors disabled:opacity-50 ${className ?? ""}`}
    >
      <span aria-hidden="true">{sent ? "✓" : "🧭"}</span>
      <span>{sent ? "Sent — Claude will explain" : label}</span>
      {!sent && <span aria-hidden="true">▸</span>}
    </button>
  );
}
