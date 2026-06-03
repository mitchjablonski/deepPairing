import { useEffect, useState } from "react";
import { apiBase, getCurrentHost } from "../lib/api";
import { useConnectionStore } from "../stores/connection";

/**
 * MP1 (multi-project spike) — bare project switcher. Lists every live
 * deepPairing daemon (from /api/projects, which the daemon discovers by
 * sweeping the deterministic port window) and lets you repoint the SPA at
 * another project's daemon without opening a second tab. No "agent waiting"
 * badges yet — this slice just proves the switch re-points fetches + WS across
 * ports in a real browser.
 */
interface DiscoveredProject {
  projectRoot: string;
  projectHash: string;
  port: number;
  label: string;
  isSelf: boolean;
}

export function ProjectSwitcher() {
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const switchProject = useConnectionStore((s) => s.switchProject);
  const projectHash = useConnectionStore((s) => s.projectHash);

  const refresh = () => {
    fetch(`${apiBase()}/api/projects`)
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  // The currently-selected project: match by the host we're pointed at, else
  // by the active projectHash from the connection store.
  const currentHost = getCurrentHost();
  const current =
    projects.find((p) => `localhost:${p.port}` === currentHost) ??
    projects.find((p) => p.projectHash === projectHash);

  const choose = async (p: DiscoveredProject) => {
    setOpen(false);
    if (`localhost:${p.port}` === currentHost) return;
    setSwitching(true);
    try {
      await switchProject(`localhost:${p.port}`);
    } finally {
      setSwitching(false);
    }
  };

  // Only show the switcher when there's actually more than one project to
  // switch between — otherwise it's noise.
  if (projects.length <= 1) return null;

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-2xs bg-surface-elevated border border-border-default
                   text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
        title="Switch project"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-accent-green shrink-0" />
        <span className="font-medium max-w-[160px] truncate">
          {switching ? "Switching…" : current?.label ?? "Select project"}
        </span>
        <span className="text-text-muted">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 min-w-[220px] bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden">
            <div className="px-3 py-1.5 text-[9px] font-semibold text-text-muted uppercase tracking-wide border-b border-border-subtle">
              Projects ({projects.length})
            </div>
            {projects.map((p) => {
              const isCurrent = current?.port === p.port;
              return (
                <button
                  key={p.port}
                  onClick={() => choose(p)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                    isCurrent ? "bg-surface-hover text-text-primary" : "text-text-secondary hover:bg-surface-hover/60"
                  }`}
                  title={p.projectRoot}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isCurrent ? "bg-accent-green" : "bg-text-muted"}`} />
                  <span className="flex-1 min-w-0 truncate">{p.label}</span>
                  <span className="text-2xs text-text-muted font-mono shrink-0">:{p.port}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
