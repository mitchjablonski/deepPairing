import type { AgentEvent } from "@deeppairing/shared";

const sigColors: Record<string, string> = {
  high: "bg-accent-red-dim text-accent-red",
  medium: "bg-accent-amber-dim text-accent-amber",
  low: "bg-surface-elevated text-text-secondary",
};

export function FindingsEvent({ event }: { event: AgentEvent & { type: "findings" } }) {
  return (
    <div className="mx-3 my-2 p-3 bg-accent-cyan-dim/40 border border-accent-cyan/15 rounded-lg">
      <div className="text-xs font-semibold text-accent-cyan mb-2">Research Findings</div>
      <p className="text-sm text-text-primary mb-2">{event.summary}</p>
      <div className="space-y-1.5">
        {event.findings.map((f, i) => (
          <div key={i} className="flex items-start gap-2 text-xs">
            <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${sigColors[f.significance] ?? sigColors.low}`}>
              {f.category}
            </span>
            <span className="text-text-secondary">{f.detail}</span>
          </div>
        ))}
      </div>
      {event.openQuestions && event.openQuestions.length > 0 && (
        <div className="mt-2 pt-2 border-t border-accent-cyan/10">
          <div className="text-xs font-medium text-accent-cyan/70 mb-1">Open Questions</div>
          <ul className="text-xs text-text-muted list-disc list-inside">
            {event.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
