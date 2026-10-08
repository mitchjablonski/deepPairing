import { useEffect, useMemo, useState } from "react";
import type { RequestIntent } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { useToastStore } from "../stores/toast";
import { useAgentRecentlyActive } from "../hooks/useAgentRecentlyActive";
import { noAgentLive } from "../lib/liveness";

/**
 * G1 (#198b) — the REQUEST COMPOSER. A quiet banner-row affordance that lets the
 * human INITIATE: compose a free-text request to the agent, tagged with one of
 * three intent presets. Mirrors the ResumeQuestionsBanner placement + styling
 * (the banner row, NOT an artifact footer) so it reads as a peer of the other
 * quiet strips.
 *
 * #204 (UX M3 — banner fold) — the row is COLLAPSED by default to a single
 * compact "✎ Ask Claude for something" affordance; the preset chips + input only
 * appear once expanded on demand. Pre-#204 the collapsed row was already a full
 * band of label + 3 preset chips + pips, so with a queue banner above it the idle
 * screen stacked several heavy strips. Collapsed, it's one quiet row.
 *
 * Two surfaces to the agent (the E1 bridge pattern):
 *  (i)  a LIVE, actively-polling agent's next check_feedback delivers the request
 *       as a priority line (server-side; ranked after unanswered questions +
 *       freshlyRejected);
 *  (ii) when NO agent is live — OR a live agent has gone idle (#204 UX3) — this
 *       composer yields a one-click resume-prompt telling the agent to call
 *       check_feedback and serve the request with the right artifact type.
 *
 * Pending requests render with a served/unserved pip; a served request (the
 * agent linked a fulfilling artifact) can be clicked to jump to that artifact.
 */

const PRESETS: Array<{ intent: RequestIntent; label: string; template: string; placeholder: string }> = [
  { intent: "explain", label: "Explain how…", template: "Explain how ", placeholder: "the auth middleware works" },
  { intent: "plan", label: "Plan…", template: "Plan ", placeholder: "the rate-limiter before building" },
  { intent: "status", label: "Status?", template: "Status?", placeholder: "anything specific? (optional)" },
];

/**
 * #204 (UX3) — the conservative "registered but idle" window. A working agent
 * checks in ~every 30s, so we only treat a LIVE session as idle once we've
 * OBSERVED activity that has since gone quiet for ~3 poll cycles (90s). A session
 * we've NEVER seen poll (agentActivityAt == null) is deliberately NOT idle — it
 * may be about to check in, and surfacing the resume bridge then would be
 * premature nagging. The bridge therefore needs POSITIVE evidence of staleness.
 */
const IDLE_WINDOW_MS = 90_000;

/** The resume prompt handed to the human when no live/active agent will pick the
 *  request up soon. Built from the CURRENT pending count so a copy fired right
 *  after a submit (from the toast action) reflects the just-added request. */
function buildResumePrompt(n: number): string {
  return (
    `Resume our deepPairing session: I sent ${n} request${n === 1 ? "" : "s"} for you. ` +
    `Call check_feedback to see ${n === 1 ? "it" : "them"} (${n === 1 ? "it arrives" : "they arrive"} as a "Human requests" block), then serve ${n === 1 ? "it" : "each"} with the matching present_* tool (explain→present_explainer, plan→present_plan/present_spec, status→present_debrief), passing servedRequestId so it clears.`
  );
}

/**
 * #430 PR 5 — the request STATUS half of this banner (pips + the resume bridge),
 * shared so that with the Next-up bar ON it lives in the bar (design §5: "request
 * pips move to the Waiting lane") with exactly the same rules and actions.
 */
export function useRequestResumeBridge() {
  const requests = useArtifactStore((s) => s.requests);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  // #204 (UX3) — recency, so a live-but-idle session can still surface the bridge.
  const everActive = useConnectionStore((s) => s.agentActivityAt != null);
  const recentlyActive = useAgentRecentlyActive(IDLE_WINDOW_MS);
  const [copied, setCopied] = useState(false);
  const pending = useMemo(() => requests.filter((r) => !r.servedByArtifactId), [requests]);
  const noAgent = noAgentLive(activeSessions);
  // #204 (UX3) — a LIVE session we've SEEN poll but which has since gone quiet
  // past the window. Never fires on a never-polled session (everActive === false).
  const idleRegistered = !noAgent && everActive && !recentlyActive;
  // #204 (UX3) — the resume bridge appears when there ARE pending requests and no
  // live, actively-polling agent will pick them up soon: either no agent is live,
  // OR a live agent has gone idle. It stays hidden while an agent polls (no nag).
  const showResumeBridge = pending.length > 0 && (noAgent || idleRegistered);
  const copyResume = async () => {
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!writeText) return;
    // Read the CURRENT pending count (not the render-time closure) so a copy from
    // the just-submitted toast action reflects the request that was just added.
    const count = useArtifactStore.getState().requests.filter((r) => !r.servedByArtifactId).length;
    try {
      await writeText(buildResumePrompt(count));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied — non-fatal */
    }
  };
  return { requests, pending, noAgent, showResumeBridge, copyResume, copied };
}

/** The served/unserved pips: a served pip jumps to the fulfilling artifact. */
export function RequestPips() {
  const requests = useArtifactStore((s) => s.requests);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  if (requests.length === 0) return null;
  return (
    <div className="flex items-center gap-1 shrink-0 flex-wrap" data-testid="request-pips">
      {requests.map((r) => {
        const served = !!r.servedByArtifactId;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => { if (r.servedByArtifactId) selectArtifact(r.servedByArtifactId); }}
            data-served={served ? "true" : "false"}
            className={`px-1.5 py-0.5 rounded-full text-2xs font-medium transition-colors ${
              served
                ? "bg-accent-green-dim text-accent-green hover:brightness-110"
                : "bg-accent-amber-dim text-accent-amber"
            }`}
            title={served ? `Served — click to jump to the artifact. "${r.text}"` : `Waiting on Claude. "${r.text}"`}
          >
            {served ? "✓" : "○"} {r.intent}
          </button>
        );
      })}
    </div>
  );
}

/** The resume-bridge button ("Copy resume prompt" for pending requests). */
export function RequestResumeButton({ bridge, className = "ml-auto", label = "Copy resume prompt" }: { bridge: ReturnType<typeof useRequestResumeBridge>; className?: string; label?: string }) {
  if (!bridge.showResumeBridge) return null;
  return (
    <button
      type="button"
      onClick={() => void bridge.copyResume()}
      className={`${className} shrink-0 px-2 py-0.5 rounded text-2xs font-medium bg-accent-blue-dim text-accent-blue hover:bg-accent-blue-dim/80 transition-colors`}
      title={
        bridge.noAgent
          ? "No agent is live — copy a paste-able resume prompt for Claude Code"
          : "Claude has gone idle — copy a paste-able resume prompt to hand it your request"
      }
      data-testid="request-resume-prompt"
    >
      {bridge.copied ? "Copied ✓" : label}
    </button>
  );
}

/** #430 PR 5 — with the Next-up bar ON, the composer row collapses to this
 *  header button (design §5); it opens the same composer. */
export const OPEN_REQUEST_COMPOSER_EVENT = "dp:open-request-composer";

export function RequestComposerBanner({ compact = false }: {
  /** #430 PR 5 — the Next-up bar is ON: no standing row. The header "Request"
   *  button opens the composer (the row shows only while composing), and the
   *  pips + resume bridge live in the bar. OFF (default): exactly as before. */
  compact?: boolean;
} = {}) {
  const submitRequest = useArtifactStore((s) => s.submitRequest);
  const connected = useConnectionStore((s) => s.connected);
  const pushToast = useToastStore((s) => s.push);
  const bridge = useRequestResumeBridge();
  const { noAgent, copyResume } = bridge;

  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<RequestIntent>("explain");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // #430 PR 5 — the header "Request" button (bar ON) opens the composer.
  useEffect(() => {
    const openComposer = () => {
      setIntent(PRESETS[0]!.intent);
      setText(PRESETS[0]!.template);
      setOpen(true);
    };
    window.addEventListener(OPEN_REQUEST_COMPOSER_EVENT, openComposer);
    return () => window.removeEventListener(OPEN_REQUEST_COMPOSER_EVENT, openComposer);
  }, []);

  // The composer only makes sense against a live session (there has to be a
  // session store to persist into). It's hidden entirely until connected.
  if (!connected) return null;

  const pickPreset = (p: (typeof PRESETS)[number]) => {
    setIntent(p.intent);
    setText(p.template);
    setOpen(true);
  };

  const activePreset = PRESETS.find((p) => p.intent === intent);

  const send = async () => {
    const t = text.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    try {
      await submitRequest(t, intent);
      setText("");
      setOpen(false);
      // #204 (UX M2) — confirm the submit with a liveness-branched toast (the ○
      // pip alone was too quiet). Same shared predicate (noAgentLive) as the
      // resume bridge, so the two surfaces can't drift.
      if (noAgent) {
        pushToast({
          kind: "info",
          title: "Saved — Claude will see this when the session resumes",
          body: "No agent is live. Copy the resume prompt to hand it to Claude.",
          action: { label: "Copy resume prompt", onClick: () => void copyResume() },
        });
      } else {
        pushToast({
          kind: "success",
          title: "Sent to Claude",
          body: "It'll pick this up on its next check-in (about every 30s while working).",
        });
      }
    } catch {
      /* store toasted + rolled back — keep the composer open for retry */
    } finally {
      setSubmitting(false);
    }
  };

  // #430 PR 5 — bar ON and not composing: no standing row at all.
  if (compact && !open) return null;

  return (
    <div
      data-testid="request-composer"
      className="px-3 py-1 bg-accent-blue-dim/40 border-b border-accent-blue/15 flex items-center gap-2 flex-wrap"
    >
      {/* #204 (UX M3) — COLLAPSED: a single compact trigger. Expands the full
          composer (presets + input) on demand rather than always occupying a
          heavy band of label + chips. */}
      {!open ? (
        <button
          type="button"
          onClick={() => pickPreset(PRESETS[0]!)}
          data-testid="request-composer-trigger"
          className="shrink-0 flex items-center gap-1.5 px-2 py-0.5 rounded text-2xs font-medium text-accent-blue hover:bg-accent-blue-dim/70 transition-colors"
        >
          <span aria-hidden="true">✎</span>
          <span>Ask Claude for something</span>
        </button>
      ) : (
        <>
          <span className="text-2xs shrink-0" aria-hidden="true">✎</span>
          <span className="text-2xs text-accent-blue font-medium shrink-0">Ask Claude for something</span>
          {/* Preset chips — only while expanded */}
          <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Request presets">
            {PRESETS.map((p) => (
              <button
                key={p.intent}
                type="button"
                onClick={() => pickPreset(p)}
                aria-pressed={intent === p.intent}
                className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors ${
                  intent === p.intent
                    ? "bg-accent-blue-strong text-white"
                    : "bg-accent-blue-dim text-accent-blue hover:bg-accent-blue-dim/70"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Pending request pips (served vs unserved) — always visible so the
          collapsed row still reflects outstanding requests. #430 PR 5: with the
          bar ON (compact) they live in the bar instead. */}
      {!compact && <RequestPips />}

      {/* When no live/active agent will pick the pending requests up soon, hand
          the human a resume prompt (no-agent OR idle-registered — see #204 UX3). */}
      {!compact && <RequestResumeButton bridge={bridge} />}

      {/* The expanded composer input + a persistent example (UX L3). */}
      {open && (
        <div className="basis-full flex items-center gap-2 mt-1.5 flex-wrap">
          <input
            type="text"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void send(); }
              if (e.key === "Escape") { setOpen(false); }
            }}
            placeholder={activePreset?.placeholder ?? ""}
            aria-label="Your request to Claude"
            disabled={submitting}
            className="flex-1 min-w-0 px-2.5 py-1 bg-surface-secondary border border-border-default rounded text-xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!text.trim() || submitting}
            className="shrink-0 px-2.5 py-1 rounded text-2xs font-semibold text-white bg-accent-blue-strong hover:bg-accent-blue/80 disabled:opacity-50 transition-colors"
          >
            Send request
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="shrink-0 px-2 py-1 text-2xs text-text-muted hover:text-text-secondary transition-colors"
          >
            Cancel
          </button>
          {/* #204 (UX L3) — the preset template ("Explain how ") fills the input,
              which hides the placeholder EXAMPLE. Keep the example visible here so
              the human still sees what to fill in. */}
          {activePreset?.placeholder && (
            <p className="basis-full text-2xs text-text-muted mt-0.5" data-testid="request-example-hint">
              e.g. {activePreset.placeholder}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
