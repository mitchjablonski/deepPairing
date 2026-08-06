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
 *
 * K2 (#216) — grace window before the alarm. A freshly-connected session with
 * no artifacts yet is the EXPECTED state: the header shows the reassuring
 * "Connected — waiting for the agent's first move." Firing this alarming yellow
 * "Claude may not be using deepPairing tools yet" banner at that same instant
 * contradicts the reassurance for a run that is simply still gathering. So we
 * hold the banner for the first GRACE_MS of a fresh session (the timer re-arms
 * on a project switch). If the skill genuinely isn't loaded, the warning still
 * surfaces the moment the grace passes — the honest signal for the
 * genuinely-stuck case is kept, just not fired during the window where waiting
 * is normal. An arriving artifact (runtime proof) or a positive skill-status
 * short-circuits to null regardless, so the grace only ever DELAYS the
 * negative case; it never suppresses a true positive.
 */

const DISMISS_KEY = "dp:skill-banner-dismissed";

/** How long a fresh session is allowed to sit artifact-less before the
 *  not-loaded banner is treated as a real warning rather than expected waiting.
 *  45s comfortably covers a normal gather → first `present_*` round-trip. */
const GRACE_MS = 45_000;

interface SkillStatus {
  claudeMdHasMarker: boolean;
  recentArtifactActivity: boolean;
  pairingProtocolSkillLikelyLoaded: boolean;
  evidence: string;
}

export function SkillLoadBanner({ graceMs = GRACE_MS }: { graceMs?: number } = {}) {
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

  // K2 — the grace window (see the module doc). Held closed while a fresh
  // session is within its first `graceMs`; re-armed on a project switch so a
  // freshly-opened project gets its own window. graceMs<=0 opens immediately
  // (used by tests that exercise the not-loaded/dismiss logic directly).
  const [graceElapsed, setGraceElapsed] = useState(graceMs <= 0);
  useEffect(() => {
    if (graceMs <= 0) { setGraceElapsed(true); return; }
    setGraceElapsed(false);
    const t = setTimeout(() => setGraceElapsed(true), graceMs);
    return () => clearTimeout(t);
  }, [graceMs, projectHash]);

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
  // K2 — during the grace window, a not-loaded status is EXPECTED waiting, not
  // a fault — hold the alarm so it doesn't contradict the reassuring header.
  if (!graceElapsed) return null;

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
        <code className="text-[11px] bg-surface-elevated px-1 py-0.5 rounded">node packages/mcp-server/dist/cli/init.js init</code> to add the protocol to CLAUDE.md.
        {/* U6 — surface the doctor command. Pre-U6, users hit this banner with
            no diagnostic command in sight; the council ease-of-use review
            flagged it as the third highest friction point. Now the recovery
            path is one copy-paste away. */}
        <div className="mt-1 text-[10px] text-text-muted">
          If those don't help, run{" "}
          <code className="text-[11px] bg-surface-elevated px-1 py-0.5 rounded">node packages/mcp-server/dist/cli/init.js doctor --fix</code>
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
