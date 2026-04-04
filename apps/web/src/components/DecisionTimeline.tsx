import type { AgentEvent } from "@deeppairing/shared";
import { useSessionStore } from "../stores/session";

interface DecisionTimelineEntry {
  decisionId: string;
  context: string;
  selectedTitle?: string;
  status: "pending" | "resolved";
  eventIndex: number;
}

function extractDecisions(events: AgentEvent[]): DecisionTimelineEntry[] {
  const entries: DecisionTimelineEntry[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type !== "decision_request") continue;

    // Check if a decision was resolved by looking for status/result events after
    const isResolved = events.slice(i + 1).some(
      (e) => e.type === "status" && e.phase === "executing",
    );

    // Try to find which option was selected from reasoning events
    let selectedTitle: string | undefined;
    if (isResolved) {
      const reasoningAfter = events.slice(i + 1).find((e) => e.type === "reasoning");
      if (reasoningAfter && reasoningAfter.type === "reasoning") {
        selectedTitle = reasoningAfter.action;
      }
    }

    entries.push({
      decisionId: event.decisionId,
      context: event.context,
      selectedTitle,
      status: isResolved ? "resolved" : "pending",
      eventIndex: i,
    });
  }

  return entries;
}

export function DecisionTimeline() {
  const events = useSessionStore((s) => s.events);
  const decisions = extractDecisions(events);

  if (decisions.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-gray-200 mt-2 pt-2">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 px-2">
        Decision History
      </div>
      <div className="space-y-1 px-2">
        {decisions.map((d) => (
          <div
            key={d.decisionId}
            className="flex items-start gap-2 text-xs"
          >
            <div className="mt-1 shrink-0">
              {d.status === "resolved" ? (
                <span className="inline-block w-3 h-3 rounded-full bg-green-500 text-white text-[8px] leading-3 text-center font-bold">
                  &#10003;
                </span>
              ) : (
                <span className="inline-block w-3 h-3 rounded-full border-2 border-rose-400 animate-pulse" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-gray-700 truncate">{d.context}</p>
              {d.selectedTitle && (
                <p className="text-gray-400 truncate">→ {d.selectedTitle}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
