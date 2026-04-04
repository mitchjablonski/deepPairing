import type { AgentEvent } from "@deeppairing/shared";

export function ReasoningEvent({ event }: { event: AgentEvent & { type: "reasoning" } }) {
  return (
    <div className="mx-3 my-1 px-3 py-2 bg-accent-violet-dim/40 border-l-2 border-accent-violet rounded-r text-xs">
      <span className="font-semibold text-accent-violet">Reasoning:</span>{" "}
      <span className="text-text-primary">{event.action}</span>
      <p className="text-text-muted mt-0.5">{event.reasoning}</p>
    </div>
  );
}
