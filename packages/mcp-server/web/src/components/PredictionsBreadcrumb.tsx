import { useEffect, useState } from "react";

/**
 * N3.3 — Past-predictions breadcrumb.
 *
 * On high-stakes decision artifacts, surface the user's prior predictions on
 * similar past decisions so they can calibrate: "You predicted X on a
 * similar decision 3 months ago — was that right?"
 *
 * Data source: GET /api/predictions, which walks past sessions in this
 * project and returns resolved decisions with a `predictedOutcome` captured
 * at the time.
 *
 * Render: compact row of cards above the DecisionCard. Silent when nothing
 * matches — no "no predictions found" state; the breadcrumb is an assist,
 * not an always-on label.
 */

interface Retrospective {
  id: string;
  decisionId: string;
  verdict: "right" | "wrong" | "mixed";
  note?: string;
  createdAt: string;
}

interface Prediction {
  sessionId: string;
  sessionTitle?: string;
  artifactId: string;
  artifactTitle: string;
  context: string;
  decisionId: string;
  chosenOptionTitle: string;
  predictedOutcome: string;
  confidence?: "low" | "medium" | "high";
  resolvedAt: string;
  daysAgo: number;
  retrospective?: Retrospective;
}

function humanizeAge(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 60) return "1 month ago";
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  if (days < 730) return "1 year ago";
  return `${Math.round(days / 365)} years ago`;
}

export function PredictionsBreadcrumb({
  concept,
  excludeArtifactId,
}: {
  concept: string;
  excludeArtifactId?: string;
}) {
  const [predictions, setPredictions] = useState<Prediction[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!concept?.trim()) return;
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ concept, limit: "3" });
        if (excludeArtifactId) params.set("excludeArtifactId", excludeArtifactId);
        const res = await fetch(`http://${window.location.host}/api/predictions?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setPredictions(data.predictions ?? []);
      } catch {
        // Silent — the breadcrumb is an assist; failure shouldn't bother the user.
      }
    })();
    return () => { cancelled = true; };
  }, [concept, excludeArtifactId]);

  if (!predictions || predictions.length === 0) return null;

  // O3: render as a pill by default — the old amber card dominated every
  // high-stakes decision with the same visual weight. The pill opens the
  // full history on click. Future expansion: auto-expand when a high-
  // confidence prior prediction contradicts the agent's recommendation.
  if (!expanded) {
    const n = predictions.length;
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        aria-label={`Show ${n} prior prediction${n === 1 ? "" : "s"} on similar decisions`}
        className="mb-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-accent-amber/40
                   bg-accent-amber-dim/30 text-2xs text-accent-amber hover:bg-accent-amber-dim/50 transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5v2.5l1.5 1.5" />
        </svg>
        <span className="font-medium">
          {n} prior prediction{n === 1 ? "" : "s"}
        </span>
        <span className="text-[10px] opacity-70">↗</span>
      </button>
    );
  }

  return (
    <div
      className="mb-3 rounded border border-accent-amber/30 bg-accent-amber-dim/40 px-3 py-2"
      role="region"
      aria-label="Past predictions on similar decisions"
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-2xs font-semibold text-accent-amber uppercase tracking-wide flex items-center gap-1.5">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <circle cx="6" cy="6" r="4.5" />
            <path d="M6 3.5v2.5l1.5 1.5" />
          </svg>
          You've predicted this before
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label="Collapse predictions"
          className="text-2xs text-text-muted hover:text-text-primary"
        >
          Collapse
        </button>
      </div>
      <ul className="space-y-2.5">
        {predictions.map((p) => (
          <PredictionRow
            key={`${p.sessionId}:${p.decisionId}`}
            prediction={p}
            onRetrospected={(verdict) => {
              // Optimistic update — the server is the source of truth, but
              // the user gets immediate feedback without a refetch.
              setPredictions((cur) =>
                cur ? cur.map((it) =>
                  it.decisionId === p.decisionId
                    ? { ...it, retrospective: { id: "local", decisionId: p.decisionId, verdict, createdAt: new Date().toISOString() } }
                    : it,
                ) : cur,
              );
            }}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * P2 — a single prediction row with the retrospective affordance. Shows
 * the captured prediction, and either (a) the existing verdict if the user
 * has already looked back, or (b) ✓ / ◐ / ✗ buttons to mark it now.
 */
function PredictionRow({
  prediction: p,
  onRetrospected,
}: {
  prediction: Prediction;
  onRetrospected: (v: "right" | "wrong" | "mixed") => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (verdict: "right" | "wrong" | "mixed") => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    // Optimistic — flip the row immediately; roll back on failure.
    onRetrospected(verdict);
    try {
      const res = await fetch(`http://${window.location.host}/api/retrospectives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: p.decisionId, verdict }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err: any) {
      setError(err?.message ?? "failed");
    } finally {
      setSubmitting(false);
    }
  };

  const verdictCopy: Record<"right" | "wrong" | "mixed", string> = {
    right: "Prediction held up",
    wrong: "Prediction was wrong",
    mixed: "Mixed outcome",
  };
  const verdictTone: Record<"right" | "wrong" | "mixed", string> = {
    right: "text-accent-green",
    wrong: "text-accent-red",
    mixed: "text-text-muted",
  };

  return (
    <li className="text-2xs leading-relaxed text-text-secondary">
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span className="text-text-muted">{humanizeAge(p.daysAgo)}:</span>
        <span className="font-medium text-text-primary">"{p.predictedOutcome}"</span>
        {p.confidence && (
          <span className="text-[10px] text-text-muted">({p.confidence} confidence)</span>
        )}
      </div>
      <div className="text-[10px] text-text-muted mt-0.5">
        on "{p.artifactTitle}" — chose {p.chosenOptionTitle}
      </div>
      {p.retrospective ? (
        <div className={`mt-1 text-[10px] font-medium ${verdictTone[p.retrospective.verdict]}`}>
          {p.retrospective.verdict === "right" ? "✓" : p.retrospective.verdict === "wrong" ? "✗" : "◐"}{" "}
          {verdictCopy[p.retrospective.verdict]}
          {p.retrospective.note && (
            <span className="text-text-muted italic font-normal"> — "{p.retrospective.note}"</span>
          )}
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-1.5 text-[10px]">
          <span className="text-text-muted italic">Looking back, was this prediction right?</span>
          <button
            type="button"
            disabled={submitting}
            onClick={() => submit("right")}
            className="px-1.5 py-0.5 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green-dim/30 transition-colors"
            aria-label="Mark prediction as right"
          >
            ✓ Right
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => submit("mixed")}
            className="px-1.5 py-0.5 rounded border border-border-default text-text-secondary hover:bg-surface-hover transition-colors"
            aria-label="Mark prediction as mixed"
          >
            ◐ Mixed
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => submit("wrong")}
            className="px-1.5 py-0.5 rounded border border-accent-red/40 text-accent-red hover:bg-accent-red-dim/30 transition-colors"
            aria-label="Mark prediction as wrong"
          >
            ✗ Wrong
          </button>
          {error && <span className="text-accent-red">({error})</span>}
        </div>
      )}
    </li>
  );
}
