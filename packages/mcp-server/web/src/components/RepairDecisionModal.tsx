import { useMemo, useState } from "react";
import { buildRepairPrompt } from "../lib/repairPrompt";
import { API_BASE } from "../lib/api";

interface Props {
  sessionId: string;
  decisionContext: string;
  options: Array<{
    id: string;
    title: string;
    description?: string;
    pros?: string[];
    cons?: string[];
    recommendation?: boolean;
  }>;
  chosenOptionId: string;
  chosenReasoning?: string;
  resolvedAt?: string;
  decisionId?: string;
  onClose: () => void;
}

/**
 * Re-pair modal: generate a structured prompt the developer can paste into a
 * fresh Claude Code session to revisit a past decision.
 *
 * Why not "drive the agent to replay"? deepPairing is an MCP server — we don't
 * drive Claude Code; it drives us. Instead of pretending to branch a session,
 * we give the human a clean, complete prompt they can take anywhere.
 */
export function RepairDecisionModal({
  sessionId,
  decisionContext,
  options,
  chosenOptionId,
  chosenReasoning,
  resolvedAt,
  decisionId,
  onClose,
}: Props) {
  const [userNote, setUserNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const promptMarkdown = useMemo(
    () =>
      buildRepairPrompt({
        sessionId,
        decisionContext,
        options,
        chosenOptionId,
        chosenReasoning,
        resolvedAt,
        userNote,
      }),
    [sessionId, decisionContext, options, chosenOptionId, chosenReasoning, resolvedAt, userNote],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(promptMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard unavailable — copy the text manually below.");
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: promptMarkdown,
          decisionId,
          sessionId,
        }),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      const data = await res.json();
      setSavedPath(data.relPath ?? data.path ?? "saved");
    } catch (err: any) {
      setError(err?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Re-pair decision"
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        className="fixed top-[10%] left-1/2 -translate-x-1/2 z-50 w-[720px] max-w-[92vw] max-h-[80vh]
                   bg-surface-elevated border border-border-default rounded-xl shadow-2xl
                   flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-default">
          <div>
            <h2 className="text-sm font-bold text-text-primary">Re-pair this decision</h2>
            <p className="text-2xs text-text-muted mt-0.5">
              Paste this into a fresh Claude Code session to revisit with clean context.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-2xs"
            title="Close (Esc)"
          >
            Esc
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <label className="block text-2xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
              Why are you reconsidering? <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <textarea
              autoFocus
              rows={2}
              value={userNote}
              onChange={(e) => setUserNote(e.target.value)}
              placeholder="e.g. Team moved to serverless; cost assumptions changed; new security finding…"
              className="w-full px-3 py-2 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                         placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none"
            />
          </div>

          <div>
            <label className="block text-2xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
              Generated prompt
            </label>
            <pre className="px-3 py-2 bg-surface-primary border border-border-default rounded text-2xs text-text-secondary
                           font-mono whitespace-pre-wrap max-h-[40vh] overflow-y-auto">
              {promptMarkdown}
            </pre>
          </div>

          {error && (
            <p className="text-2xs text-accent-red">{error}</p>
          )}
          {savedPath && (
            <p className="text-2xs text-accent-green">
              Saved to <code className="font-mono">{savedPath}</code>
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-default bg-surface-secondary">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 bg-surface-elevated border border-border-default text-text-secondary text-xs rounded
                       hover:bg-surface-hover disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : savedPath ? "Saved ✓" : "Save to .deeppairing/prompts/"}
          </button>
          <button
            onClick={copy}
            className="px-3 py-1.5 bg-accent-violet text-white text-xs font-medium rounded
                       hover:bg-accent-violet/80 transition-colors press-scale"
          >
            {copied ? "Copied ✓" : "Copy prompt"}
          </button>
        </div>
      </div>
    </>
  );
}
