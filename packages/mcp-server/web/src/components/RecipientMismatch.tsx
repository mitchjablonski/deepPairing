import { useMemo } from "react";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { sessionLabelsFrom } from "../lib/sessionLabel";

/**
 * #656 item 1 / #668 item 2 — both composers that write to the agent (the
 * bottom message box and "Ask Claude for something") send to the tab's BOUND
 * session, but the agent filter can show another agent's work above them.
 * One shared answer to "who gets this?", so the two can't drift.
 *
 * Sol P2 (#657) — disclosure keys on the KNOWN bound/filter identities, not on
 * catalog membership: lazy re-registration and catalog loss can leave either id
 * out of activeSessions while the pane still shows the filtered agent. Shared
 * human label when known, else a stable short id.
 */
export function useMessageRecipient() {
  const sessionId = useConnectionStore((st) => st.sessionId);
  const activeSessions = useConnectionStore((st) => st.activeSessions);
  const switchSession = useConnectionStore((st) => st.switchSession);
  const agentFilter = useArtifactStore((st) => st.agentFilter);
  const labelOf = useMemo(() => {
    const base = sessionLabelsFrom(activeSessions);
    return (sid: string) => {
      const label = base[sid];
      if (!label) return `session …${sid.slice(-8)}`;
      const clash = activeSessions.filter((x) => base[x.sessionId] === label).length > 1;
      return clash ? `${label} (${sid.slice(-8)})` : label;
    };
  }, [activeSessions]);
  const viewingOther = agentFilter !== "all" && !!sessionId && agentFilter !== sessionId;
  const multiAgent = activeSessions.length > 1 || viewingOther;
  return {
    sessionId,
    viewingOther,
    recipient: multiAgent && sessionId ? labelOf(sessionId) : null,
    viewingLabel: viewingOther ? labelOf(agentFilter) : null,
    // Switch only to a target the catalog actually knows; never invent one.
    switchable: viewingOther && activeSessions.some((x) => x.sessionId === agentFilter),
    switchToViewed: () => { if (agentFilter !== "all") switchSession(agentFilter); },
    // Sol (#671) — no bound session while several agents are around: a write
    // would carry no X-Session-Id, so there is no honest recipient to name.
    ambiguous: !sessionId && activeSessions.length > 1,
  };
}

/** "Viewing X · <noun> go to Y [Switch to X]" — shown only while the filter is
 *  on a different agent than the one the composer writes to. Nothing switches
 *  on its own. */
export function RecipientMismatch({ noun, testId, className = "" }: { noun: string; testId: string; className?: string }) {
  const { viewingOther, viewingLabel, recipient, switchable, switchToViewed } = useMessageRecipient();
  if (!viewingOther) return null;
  return (
    <div data-testid={testId} className={`flex items-center gap-2 text-2xs text-accent-amber ${className}`}>
      <span className="min-w-0 truncate">
        Viewing {viewingLabel} · {noun} go to {recipient}
      </span>
      <button
        type="button"
        disabled={!switchable}
        title={switchable ? undefined : "That agent isn't available to switch to yet"}
        onClick={() => { if (switchable) switchToViewed(); }}
        className="shrink-0 px-1.5 py-0.5 rounded border border-accent-amber/40 hover:bg-accent-amber-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Switch to {viewingLabel}
      </button>
    </div>
  );
}
