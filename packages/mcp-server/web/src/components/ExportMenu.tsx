import { useState } from "react";

const API_BASE = `http://${window.location.host}`;

const formats = [
  { id: "pr-description", label: "PR Description", description: "Concise summary for pull requests" },
  { id: "pr-comments", label: "PR Comments (from pairing)", description: "Pairing findings as file:line anchored PR comments" },
  { id: "adr", label: "ADR", description: "Architecture Decision Record" },
  { id: "replay", label: "Replay Narrative", description: "Chronological walkthrough with annotations" },
  { id: "full", label: "Full Report", description: "Complete session with code" },
] as const;

export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const handleExport = async (format: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/export?format=${format}`);
      const markdown = await res.text();

      await navigator.clipboard.writeText(markdown);
      setCopied(format);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Fallback: open in new tab
      window.open(`${API_BASE}/api/export?format=${format}`, "_blank");
    }
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded text-2xs font-medium
                   text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M6 1v7M3 5l3 3 3-3M2 10h8" />
        </svg>
        {copied ? "Copied!" : "Export"}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden">
            {formats.map((fmt) => (
              <button
                key={fmt.id}
                onClick={() => handleExport(fmt.id)}
                className="w-full text-left px-3 py-2 hover:bg-surface-hover transition-colors"
              >
                <div className="text-xs font-medium text-text-primary">{fmt.label}</div>
                <div className="text-2xs text-text-muted">{fmt.description}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
