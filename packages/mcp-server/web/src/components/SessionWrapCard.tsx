import { useMemo, useState } from "react";
import { normalizeConceptKey } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { computePending } from "../lib/pending";

/**
 * D9 (H3) — the closing beat. Sessions used to end by evaporation: the
 * wrapper exits, the last visible state is a stale pill, and the learning
 * recap — the product's thesis — sits buried at the bottom of Settings.
 * When the bound session's wrapper is gone (M8's live flag), the agent is
 * quiet, and nothing is waiting on the human, this card says what was built
 * and which concepts the ledger touched, and points at the full recap.
 *
 * Dismissible per session (sessionStorage, the drafts/rail idiom).
 */
export function SessionWrapCard({ sessionId }: { sessionId: string }) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const dismissKey = `dp:wrap-dismissed:${sessionId}`;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(dismissKey) === "1"; } catch { return false; }
  });

  const stats = useMemo(() => {
    const total = artifacts.length;
    const approved = artifacts.filter((a) => a.status === "approved").length;
    const decisions = artifacts.filter((a) => a.type === "decision").length;
    // First-seen casing per normalized key — SessionMetrics' idiom.
    const conceptNames = new Map<string, string>();
    for (const a of artifacts) {
      // D9 review — harvest top-level and option concepts INDEPENDENTLY
      // (SessionMetrics' idiom): decisions normally carry concepts only on
      // options, and the early-continue skipped them entirely.
      const c = (a.content as { concept?: { name?: unknown } } | null)?.concept;
      const raw = typeof c?.name === "string" ? c.name : null;
      if (raw) {
        const key = normalizeConceptKey(raw);
        if (!conceptNames.has(key)) conceptNames.set(key, raw.trim());
      }
      const opts = (a.content as { options?: unknown } | null)?.options;
      if (Array.isArray(opts)) {
        for (const o of opts as Array<{ concept?: { name?: string } }>) {
          if (typeof o?.concept?.name === "string" && o.concept.name) {
            const k = normalizeConceptKey(o.concept.name);
            if (!conceptNames.has(k)) conceptNames.set(k, o.concept.name.trim());
          }
        }
      }
    }
    return { total, approved, decisions, concepts: [...conceptNames.values()].slice(0, 6) };
  }, [artifacts]);

  // Nothing waiting on the human is a PRECONDITION of the wrap state; if a
  // draft appears (agent came back), the parent stops rendering us — but
  // guard anyway so a stale render never claims "wrapped" over pending work.
  if (dismissed || computePending(artifacts).drafts.length > 0) return null;

  return (
    <div
      role="status"
      aria-label="Session wrapped"
      className="mx-4 mt-3 px-4 py-3 bg-surface-secondary border border-white/[0.08] rounded-lg flex items-start gap-3"
    >
      <span className="text-base shrink-0" aria-hidden>🏁</span>
      <div className="flex-1 min-w-0 text-xs text-text-secondary leading-relaxed">
        <span className="font-medium text-text-primary">Session wrapped.</span>{" "}
        {stats.total} artifact{stats.total === 1 ? "" : "s"}
        {stats.approved > 0 && <> · {stats.approved} approved</>}
        {stats.decisions > 0 && <> · {stats.decisions} decision{stats.decisions === 1 ? "" : "s"}</>}
        {stats.concepts.length > 0 && (
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            <span className="text-2xs text-text-muted">Concepts your ledger touched:</span>
            {stats.concepts.map((c) => (
              <span key={c} className="text-2xs px-1.5 py-0.5 rounded bg-surface-elevated text-text-secondary">
                {c}
              </span>
            ))}
          </div>
        )}
        <div className="mt-1 text-2xs text-text-muted">
          Full recap (approval stats, review latency, cross-session concepts) lives in Settings — press <kbd className="px-1 py-0.5 bg-surface-elevated rounded">⌘,</kbd>
        </div>
      </div>
      <button
        onClick={() => {
          setDismissed(true);
          try { sessionStorage.setItem(dismissKey, "1"); } catch {}
        }}
        className="text-text-muted hover:text-text-primary text-2xs px-2 py-0.5 rounded hover:bg-surface-hover transition-colors shrink-0"
        aria-label="Dismiss session recap"
      >
        Dismiss
      </button>
    </div>
  );
}
