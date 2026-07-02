import { useEffect, useState } from "react";
import { apiGet, apiBase } from "../lib/api";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";

/**
 * O6 — Skill-load banner. When `/api/skill-status` reports that the
 * pairing-protocol skill is probably not loaded, show a dismissible banner
 * explaining the silent failure mode and how to fix it.
 *
 * Auto-hides as soon as a first artifact arrives (proof the skill is active,
 * regardless of what the status endpoint said). Also hides if the user
 * explicitly dismissed it (session-scoped via sessionStorage).
 */

const DISMISS_KEY = "dp:skill-banner-dismissed";

interface SkillStatus {
  claudeMdHasMarker: boolean;
  recentArtifactActivity: boolean;
  pairingProtocolSkillLikelyLoaded: boolean;
  evidence: string;
}

export function SkillLoadBanner() {
  const [status, setStatus] = useState<SkillStatus | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });
  const hasArtifacts = useArtifactStore((s) => s.artifacts.length > 0);
  // C1 review — a positive status latched `resolved` FOREVER, so after a
  // project switch (new daemon, new skill state) the banner could never show
  // again until reload. Reset the cached status when the project changes.
  const projectHash = useConnectionStore((s) => s.projectHash);
  useEffect(() => {
    setStatus(null);
  }, [projectHash]);

  // C1 — the resolution states only gated RENDERING; the 30s poll (which
  // fs.readFileSync's CLAUDE.md server-side per hit) kept firing for the tab's
  // lifetime. Stop polling once anything proves the banner moot, and skip
  // fetches while the tab is hidden.
  const resolved = dismissed || hasArtifacts || Boolean(status?.pairingProtocolSkillLikelyLoaded);
  useEffect(() => {
    if (resolved) return;
    // E7 — one controller for the whole polling effect: every tick's fetch
    // carries the signal, and cleanup aborts whichever is in flight.
    const ac = new AbortController();
    const fetchStatus = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await apiGet(`${apiBase()}/api/skill-status`, { signal: ac.signal });
        if (!res.ok) return;
        const data = await res.json();
        if (!ac.signal.aborted) setStatus(data);
      } catch {
        // Silent — banner just won't show
      }
    };
    fetchStatus();
    // Recheck every 30s until we have proof the skill is loaded.
    const timer = setInterval(fetchStatus, 30000);
    return () => { ac.abort(); clearInterval(timer); };
  }, [resolved]);

  // Hide the banner as soon as we have evidence the skill is actually working.
  if (dismissed) return null;
  if (hasArtifacts) return null;
  if (!status || status.pairingProtocolSkillLikelyLoaded) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch {}
  };

  return (
    <div
      role="status"
      aria-label="Skill not loaded"
      className="flex items-start gap-2 px-4 py-2 border-b border-accent-amber/30 bg-accent-amber-dim/40 text-xs"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className="text-accent-amber shrink-0 mt-0.5">
        <path d="M7 1.5 13 12H1L7 1.5Z" />
        <path d="M7 6v3M7 10.5v.5" />
      </svg>
      <div className="flex-1 text-text-secondary leading-relaxed">
        <span className="font-medium text-text-primary">Claude may not be using deepPairing tools yet.</span>{" "}
        Try <code className="text-[11px] bg-surface-elevated px-1 py-0.5 rounded">/deeppairing:start</code> in Claude Code, or run{" "}
        <code className="text-[11px] bg-surface-elevated px-1 py-0.5 rounded">npx deeppairing init</code> to add the protocol to CLAUDE.md.
        {/* U6 — surface the doctor command. Pre-U6, users hit this banner with
            no diagnostic command in sight; the council ease-of-use review
            flagged it as the third highest friction point. Now the recovery
            path is one copy-paste away. */}
        <div className="mt-1 text-[10px] text-text-muted">
          If those don't help, run{" "}
          <code className="text-[11px] bg-surface-elevated px-1 py-0.5 rounded">npx deeppairing doctor --fix</code>
          {" "}— it diagnoses the daemon, .gitignore, Stop hook, and orphan sessions, and offers to heal them.
        </div>
        {status.evidence && (
          <div className="mt-0.5 text-[10px] text-text-muted">Why we think so: {status.evidence}</div>
        )}
      </div>
      <button
        onClick={handleDismiss}
        className="text-text-muted hover:text-text-primary text-2xs px-2 py-0.5 rounded hover:bg-surface-hover transition-colors shrink-0"
        aria-label="Dismiss banner"
      >
        Dismiss
      </button>
    </div>
  );
}
