import { useEffect, useState } from "react";
import type { PreflightTrace } from "@deeppairing/shared";
import { API_BASE, sessionHeaders } from "../lib/api";

/**
 * Y1' — "Cross-checked your N prior stances before proposing this."
 *
 * The most distinctive deepPairing mechanic — preflight against the
 * philosophy ledger — used to be invisible 99% of the session. The
 * hero block-toast fires only on a rejection match, so a user could
 * pair for an hour and never see the moat at work. PMF council round 2:
 * the breadcrumb makes the silent guard a steady drumbeat.
 *
 * Render rules (council round 2 amendments):
 * - HIDE entirely when no trace exists (older artifact, daemon-client
 *   store, or pre-Y1' install).
 * - HIDE when the trace recorded zero stances (a fresh ledger →
 *   "Cross-checked 0 prior stances" reads as "broken", not as "nothing
 *   to compare to"). When the user has accumulated stances, the line
 *   becomes meaningful.
 * - Click expands the considered concepts + near-misses inline; no
 *   modal, no navigation away from the artifact.
 *
 * Pairing-thesis copy (PMF council round 2 — over engineering chrome):
 *   "Cross-checked your N prior stances before proposing this."
 *   Near-miss line: "Almost flagged this — your past stance on `X` is adjacent."
 */

interface PreflightBreadcrumbProps {
  artifactId: string;
}

export function PreflightBreadcrumb({ artifactId }: PreflightBreadcrumbProps) {
  const [trace, setTrace] = useState<PreflightTrace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setTrace(null);
    setOpen(false);
    fetch(`${API_BASE}/api/artifacts/${encodeURIComponent(artifactId)}/preflight-trace`, {
      headers: sessionHeaders(),
    })
      .then((r) => (r.ok ? r.json() : { trace: null }))
      .then((body) => {
        if (cancelled) return;
        setTrace(body?.trace ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });

    // Y1' — listen for the live broadcast so the breadcrumb appears the
    // moment the agent records a fresh trace, without an HTTP roundtrip.
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { artifactId?: string; trace?: PreflightTrace }
        | undefined;
      if (!detail || detail.artifactId !== artifactId) return;
      if (detail.trace) setTrace(detail.trace);
    };
    window.addEventListener("dp:preflight-trace", handler as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener("dp:preflight-trace", handler as EventListener);
    };
  }, [artifactId]);

  if (!loaded) return null;
  if (!trace) return null;
  // Hide on empty ledger — a "Cross-checked 0 stances" line reads as broken.
  if (trace.consideredCount === 0) return null;

  const n = trace.consideredCount;
  const hasDetails = trace.consideredConcepts.length > 0 || trace.nearMisses.length > 0;
  const nearMiss = trace.nearMisses[0];

  return (
    <div className="border-t border-border-subtle pt-2 mt-2 text-2xs text-text-muted">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 ${
          hasDetails ? "hover:text-accent-violet cursor-pointer" : "cursor-default"
        } transition-colors`}
        aria-expanded={hasDetails ? open : undefined}
        title={hasDetails ? "Click to see what was weighed" : "Preflight trace"}
      >
        <span aria-hidden className="text-accent-violet/70">◆</span>
        <span>
          Cross-checked your {n} prior {n === 1 ? "stance" : "stances"} before proposing this.
        </span>
        {hasDetails && (
          <span aria-hidden className="opacity-60">{open ? "▾" : "▸"}</span>
        )}
      </button>

      {/* Near-miss line lives outside the expand toggle — it's the
          concrete pairing moment ("your past stance on X is adjacent")
          and shouldn't be hidden by default when present. */}
      {nearMiss && (
        <div className="mt-1 pl-4 text-accent-amber/90">
          ↳ Almost flagged this — your past stance on{" "}
          <span className="font-mono text-accent-amber">{nearMiss.concept}</span>{" "}
          is adjacent.
          {nearMiss.reason && (
            <span className="text-text-muted"> ({nearMiss.reason})</span>
          )}
        </div>
      )}

      {open && hasDetails && (
        <div className="mt-2 pl-4 space-y-1.5">
          {trace.consideredConcepts.length > 0 && (
            <div>
              <div className="text-text-secondary mb-1">Considered:</div>
              <ul className="space-y-0.5">
                {trace.consideredConcepts.map((c, i) => (
                  <li key={`c${i}`} className="flex items-start gap-2">
                    <span
                      className={`shrink-0 px-1 py-px rounded text-[9px] uppercase tracking-wide ${
                        c.source === "team"
                          ? "bg-accent-blue-dim/40 text-accent-blue"
                          : "bg-surface-elevated text-text-muted"
                      }`}
                      title={c.source === "team" ? "From .deeppairing/team.json" : "From this session"}
                    >
                      {c.source}
                    </span>
                    <span className="font-mono text-text-secondary">{c.concept}</span>
                    {c.reason && (
                      <span className="text-text-muted opacity-80">— {c.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {trace.nearMisses.length > 1 && (
            <div>
              <div className="text-accent-amber mb-1">Other near-misses:</div>
              <ul className="space-y-0.5">
                {trace.nearMisses.slice(1).map((n, i) => (
                  <li key={`n${i}`} className="font-mono text-accent-amber/80">
                    {n.concept}
                    {n.reason && (
                      <span className="text-text-muted font-sans"> — {n.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
