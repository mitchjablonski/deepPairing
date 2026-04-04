import type { AgentEvent } from "@deeppairing/shared";

export function CodeChangeEvent({ event }: { event: AgentEvent & { type: "code_change" } }) {
  return (
    <div className="mx-3 my-1 px-3 py-2 bg-accent-amber-dim/30 border-l-2 border-accent-amber rounded-r text-xs">
      <span className="font-semibold text-accent-amber">{event.changeType}</span>{" "}
      <span className="text-text-primary font-mono">{event.filePath}</span>
    </div>
  );
}
