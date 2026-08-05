import { useMemo, useState } from "react";
import type { RequestIntent } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { noAgentLive } from "../lib/liveness";

/**
 * G1 (#198b) — the REQUEST COMPOSER. A quiet banner-row affordance that lets the
 * human INITIATE: compose a free-text request to the agent, tagged with one of
 * three intent presets. Mirrors the ResumeQuestionsBanner placement + styling
 * (the banner row, NOT an artifact footer) so it reads as a peer of the other
 * quiet strips.
 *
 * Two surfaces to the agent (the E1 bridge pattern):
 *  (i)  a LIVE agent's next check_feedback delivers the request as a priority
 *       line (server-side; ranked after unanswered questions + freshlyRejected);
 *  (ii) when NO agent is live, this composer yields a one-click resume-prompt
 *       (like ResumeQuestionsBanner) telling the agent to call check_feedback and
 *       serve the request with the right artifact type.
 *
 * Pending requests render with a served/unserved pip; a served request (the
 * agent linked a fulfilling artifact) can be clicked to jump to that artifact.
 */

const PRESETS: Array<{ intent: RequestIntent; label: string; template: string; placeholder: string }> = [
  { intent: "explain", label: "Explain how…", template: "Explain how ", placeholder: "the auth middleware works" },
  { intent: "plan", label: "Plan…", template: "Plan ", placeholder: "the rate-limiter before building" },
  { intent: "status", label: "Status?", template: "Status?", placeholder: "anything specific? (optional)" },
];

export function RequestComposerBanner() {
  const requests = useArtifactStore((s) => s.requests);
  const submitRequest = useArtifactStore((s) => s.submitRequest);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const connected = useConnectionStore((s) => s.connected);
  const activeSessions = useConnectionStore((s) => s.activeSessions);

  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<RequestIntent>("explain");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  const pending = useMemo(() => requests.filter((r) => !r.servedByArtifactId), [requests]);
  const noAgent = noAgentLive(activeSessions);

  // The composer only makes sense against a live session (there has to be a
  // session store to persist into). It's hidden entirely until connected.
  if (!connected) return null;

  const pickPreset = (p: (typeof PRESETS)[number]) => {
    setIntent(p.intent);
    setText(p.template);
    setOpen(true);
  };

  const send = async () => {
    const t = text.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    try {
      await submitRequest(t, intent);
      setText("");
      setOpen(false);
    } catch {
      /* store toasted + rolled back — keep the composer open for retry */
    } finally {
      setSubmitting(false);
    }
  };

  const n = pending.length;
  const resumePrompt =
    `Resume our deepPairing session: I sent ${n} request${n === 1 ? "" : "s"} for you. ` +
    `Call check_feedback to see ${n === 1 ? "it" : "them"} (${n === 1 ? "it arrives" : "they arrive"} as a "Human requests" block), then serve ${n === 1 ? "it" : "each"} with the matching present_* tool (explain→present_explainer, plan→present_plan/present_spec, status→present_debrief), passing servedRequestId so it clears.`;

  const copyResume = async () => {
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!writeText) return;
    try {
      await writeText(resumePrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied — non-fatal */
    }
  };

  return (
    <div
      data-testid="request-composer"
      className="px-3 py-1.5 bg-accent-blue-dim/40 border-b border-accent-blue/15 flex items-center gap-2 flex-wrap"
    >
      <span className="text-2xs shrink-0" aria-hidden="true">✎</span>
      <span className="text-2xs text-accent-blue font-medium shrink-0">Ask Claude for something</span>

      {/* Preset chips */}
      <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Request presets">
        {PRESETS.map((p) => (
          <button
            key={p.intent}
            type="button"
            onClick={() => pickPreset(p)}
            aria-pressed={open && intent === p.intent}
            className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors ${
              open && intent === p.intent
                ? "bg-accent-blue-strong text-white"
                : "bg-accent-blue-dim text-accent-blue hover:bg-accent-blue-dim/70"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Pending request pips (served vs unserved) */}
      {requests.length > 0 && (
        <div className="flex items-center gap-1 shrink-0" data-testid="request-pips">
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
      )}

      {/* When no agent is live, hand the human a resume prompt for the pending requests. */}
      {noAgent && n > 0 && (
        <button
          type="button"
          onClick={copyResume}
          className="ml-auto shrink-0 px-2 py-0.5 rounded text-2xs font-medium bg-accent-blue-dim text-accent-blue hover:bg-accent-blue-dim/80 transition-colors"
          title="No agent is live — copy a paste-able resume prompt for Claude Code"
          data-testid="request-resume-prompt"
        >
          {copied ? "Copied ✓" : "Copy resume prompt"}
        </button>
      )}

      {/* The expanded composer input */}
      {open && (
        <div className="basis-full flex items-center gap-2 mt-1.5">
          <input
            type="text"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void send(); }
              if (e.key === "Escape") { setOpen(false); }
            }}
            placeholder={PRESETS.find((p) => p.intent === intent)?.placeholder ?? ""}
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
        </div>
      )}
    </div>
  );
}
