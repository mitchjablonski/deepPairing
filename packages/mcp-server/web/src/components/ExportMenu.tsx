import { useState } from "react";
import { apiGet, apiBase } from "../lib/api";


const formats = [
  { id: "learnings", label: "Learnings", description: "Concepts named, approaches rejected" },
  { id: "pr-description", label: "PR Description", description: "Concise summary for pull requests" },
  { id: "pr-comments", label: "PR Comments (from pairing)", description: "Pairing findings as file:line anchored PR comments" },
  { id: "adr", label: "ADR", description: "Architecture Decision Record" },
  { id: "replay", label: "Replay Narrative", description: "Chronological walkthrough with annotations" },
  { id: "full", label: "Full Report", description: "Complete session with code" },
] as const;

export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // F7 — an honest failure line. The old catch opened the same URL in a new
  // tab, which CANNOT work: II2 fail-closes every /api/* request without
  // X-Project-Hash, and a plain tab navigation sends none — so the "fallback"
  // reliably produced a 403 JSON page and looked like the export was broken in
  // a new and mysterious way. Better to say the export failed.
  const [error, setError] = useState<string | null>(null);
  // Q5 — code is INCLUDED by default (the diffs are the point of a shared
  // page); the checkbox is the opt-out for a repo whose code shouldn't leave.
  const [includeCode, setIncludeCode] = useState(true);

  const handleExport = async (format: string) => {
    setError(null);
    try {
      const res = await apiGet(`${apiBase()}/api/export?format=${format}`);
      if (!res.ok) throw new Error(String(res.status));
      const markdown = await res.text();

      await navigator.clipboard.writeText(markdown);
      setCopied(format);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Export failed — is the daemon still running?");
      setTimeout(() => setError(null), 4000);
    }
    setOpen(false);
  };

  // Q5 — the shareable page. Unlike the markdown formats (copied to the
  // clipboard) this one DOWNLOADS a self-contained .html file: it's a document
  // you send to someone, not text you paste.
  const handleShareAsPage = async () => {
    setError(null);
    const url = `${apiBase()}/api/export.html?includeCode=${includeCode ? "1" : "0"}`;
    try {
      const res = await apiGet(url);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = "deeppairing-session.html";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      setCopied("html");
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Couldn't build the page — is the daemon still running?");
      setTimeout(() => setError(null), 4000);
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
        {copied ? (copied === "html" ? "Downloaded!" : "Copied!") : "Export"}
      </button>

      {error && (
        <div
          role="status"
          className="absolute right-0 top-full mt-1 z-50 w-64 px-3 py-2 rounded-lg
                     bg-surface-elevated border border-border-default shadow-xl text-2xs text-text-secondary"
        >
          {error}
        </div>
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden">
            <button
              onClick={handleShareAsPage}
              className="w-full text-left px-3 py-2 hover:bg-surface-hover transition-colors border-b border-border-default"
            >
              <div className="text-xs font-medium text-text-primary">Share as page (.html)</div>
              <div className="text-2xs text-text-muted">
                One self-contained file a colleague can read — the whole session story
              </div>
            </button>
            <label
              className="flex items-start gap-2 px-3 py-1.5 border-b border-border-default cursor-pointer"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={includeCode}
                onChange={(e) => setIncludeCode(e.target.checked)}
              />
              <span className="text-2xs text-text-muted">Include code in the page (diffs + snippets)</span>
            </label>
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
