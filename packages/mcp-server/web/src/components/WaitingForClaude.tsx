import { useEffect, useState } from "react";

/**
 * O1b — "Waiting for Claude" zero-state panel.
 *
 * Renders when there's no active session and no artifacts. Complements the
 * SkillLoadBanner: once the skill is loaded (or CLAUDE.md marker is present),
 * the user still needs to know what to DO — specifically, they need to type
 * something into Claude Code so the first tool call can fire.
 *
 * The UI shows:
 *   - The exact phrase the user can try ("Analyze the auth module.")
 *   - The daemon's port + projectRoot, so the user has no doubt which repo
 *     this daemon is watching (common confusion in multi-project setups).
 *   - A "Run doctor" action that links to the doctor command.
 */

interface DaemonInfo {
  pid: number;
  projectRoot: string;
  startedAt: string;
}

const SUGGESTIONS = [
  "Analyze the auth module — I want to understand what's there.",
  "Walk me through this PR: gh pr diff 42",
  "We're picking between argon2id and bcrypt — options?",
  "I want to refactor the config loader. Pair with me.",
];

export function WaitingForClaude() {
  const [info, setInfo] = useState<DaemonInfo | null>(null);
  const [suggestion] = useState(() => SUGGESTIONS[Math.floor(Math.random() * SUGGESTIONS.length)]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`http://${window.location.host}/api/daemon-info`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setInfo(data);
      } catch {
        // Silent — panel works without daemon info
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div
      role="status"
      aria-label="Waiting for Claude"
      className="rounded-lg border border-border-default bg-surface-secondary p-5 space-y-3"
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-blue opacity-70" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-blue" />
        </span>
        <h3 className="text-sm font-semibold text-text-primary">Waiting for Claude</h3>
      </div>

      <p className="text-xs text-text-secondary leading-relaxed">
        Open Claude Code in this project and say something. When Claude calls a
        deepPairing tool, the first artifact will appear here.
      </p>

      <div className="rounded bg-surface-elevated border border-border-default px-3 py-2">
        <div className="text-2xs text-text-muted uppercase tracking-wide mb-1">Try this</div>
        <code className="text-xs text-text-primary block font-mono break-words">{suggestion}</code>
      </div>

      {info && (
        <div className="pt-1 border-t border-border-default/60 text-2xs text-text-muted space-y-0.5">
          <div>
            <span className="text-text-muted">Daemon:</span>{" "}
            <span className="text-text-secondary font-mono">PID {info.pid}</span>
            <span className="text-text-muted"> watching </span>
            <span className="text-text-secondary font-mono">{info.projectRoot}</span>
          </div>
          <div className="text-text-muted">
            Wrong project? Run <code className="bg-surface-elevated px-1 rounded text-[10px]">npx deeppairing doctor</code> from the right directory.
          </div>
        </div>
      )}
    </div>
  );
}
