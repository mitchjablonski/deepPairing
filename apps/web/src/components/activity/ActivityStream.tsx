import { useEffect, useRef, useState, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { AgentEvent, ToolResultEvent } from "@deeppairing/shared";
import { useSessionStore } from "../../stores/session";
import { ToolCallCard } from "../ToolCallCard";
import { DecisionCard } from "../DecisionCard";
import { ActivityFilter } from "./ActivityFilter";
import { PhaseGroup } from "./PhaseGroup";
import { TextEvent } from "./events/TextEvent";
import { ThinkingEvent } from "./events/ThinkingEvent";
import { ResultEvent } from "./events/ResultEvent";
import { ErrorEvent } from "./events/ErrorEvent";
import { FindingsEvent } from "./events/FindingsEvent";
import { ReasoningEvent } from "./events/ReasoningEvent";
import { CodeChangeEvent } from "./events/CodeChangeEvent";
import { ArtifactCreatedEvent, ArtifactUpdatedEvent, CommentAddedEvent } from "./events/ArtifactEvents";
import { fadeSlideIn, scaleIn } from "../../lib/animation-presets";

interface PhaseBlock {
  phase: string;
  events: Array<{ event: AgentEvent; index: number }>;
}

/** Group events by phase (status events create new groups) */
function groupByPhase(events: AgentEvent[]): PhaseBlock[] {
  const groups: PhaseBlock[] = [];
  let current: PhaseBlock = { phase: "idle", events: [] };

  events.forEach((event, index) => {
    if (event.type === "status") {
      if (current.events.length > 0) {
        groups.push(current);
      }
      current = { phase: event.phase, events: [] };
    } else {
      current.events.push({ event, index });
    }
  });

  if (current.events.length > 0) {
    groups.push(current);
  }

  return groups;
}

/** Build a map from toolCallId → ToolResultEvent for pairing */
function buildResultMap(events: AgentEvent[]): Map<string, ToolResultEvent> {
  const map = new Map<string, ToolResultEvent>();
  for (const e of events) {
    if (e.type === "tool_result") {
      map.set(e.toolCallId, e);
    }
  }
  return map;
}

function isKeyMoment(type: string): boolean {
  return ["decision_request", "artifact_created", "findings", "result", "error"].includes(type);
}

function renderEvent(
  event: AgentEvent,
  index: number,
  resultMap: Map<string, ToolResultEvent>,
  sessionId: string | null,
) {
  const animProps = isKeyMoment(event.type) ? scaleIn : fadeSlideIn;

  let content: React.ReactNode = null;

  switch (event.type) {
    case "text":
      content = <TextEvent content={event.content} />;
      break;
    case "tool_call":
      content = (
        <div className="px-3">
          <ToolCallCard toolCall={event} toolResult={resultMap.get(event.toolCallId)} />
        </div>
      );
      break;
    case "tool_result":
      return null; // Rendered as part of ToolCallCard
    case "thinking":
      content = <ThinkingEvent content={event.content} />;
      break;
    case "result":
      content = <ResultEvent content={event.content} />;
      break;
    case "error":
      content = <ErrorEvent message={event.message} />;
      break;
    case "findings":
      content = <FindingsEvent event={event} />;
      break;
    case "reasoning":
      content = <ReasoningEvent event={event} />;
      break;
    case "decision_request":
      content = <DecisionCard event={event} sessionId={sessionId ?? ""} />;
      break;
    case "code_change":
      content = <CodeChangeEvent event={event} />;
      break;
    case "artifact_created":
      content = <ArtifactCreatedEvent event={event} />;
      break;
    case "artifact_updated":
      content = <ArtifactUpdatedEvent event={event} />;
      break;
    case "comment_added":
      content = <CommentAddedEvent event={event} />;
      break;
    case "plan_review_request":
      content = <ArtifactCreatedEvent event={{ type: "artifact_created", artifact: { id: event.artifactId, title: event.title, type: "plan", status: "reviewing", sessionId: "", version: 1, parentId: null, content: {}, agentReasoning: null, createdAt: "", updatedAt: "" } }} />;
      break;
    default:
      return null;
  }

  if (!content) return null;

  return (
    <motion.div key={index} {...animProps}>
      {content}
    </motion.div>
  );
}

export function ActivityStream() {
  const { events, status, sessionId } = useSessionStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());

  const resultMap = useMemo(() => buildResultMap(events), [events]);
  const phaseGroups = useMemo(() => groupByPhase(events), [events]);

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
    }
  }, [events.length, autoScroll]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  };

  const handleFilterToggle = (types: string[]) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      const allHidden = types.every((t) => next.has(t));
      for (const t of types) {
        if (allHidden) {
          next.delete(t);
        } else {
          next.add(t);
        }
      }
      return next;
    });
  };

  if (events.length === 0 && status === "idle") {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
        Enter a prompt and project path to start a session
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <ActivityFilter hiddenTypes={hiddenTypes} onToggle={handleFilterToggle} />

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto py-2"
      >
        <AnimatePresence mode="popLayout">
          {phaseGroups.map((group, groupIdx) => {
            const visibleEvents = group.events.filter(
              ({ event }) => !hiddenTypes.has(event.type),
            );

            if (visibleEvents.length === 0) return null;

            return (
              <PhaseGroup
                key={`${group.phase}-${groupIdx}`}
                phase={group.phase}
                eventCount={group.events.length}
                isLatest={groupIdx === phaseGroups.length - 1}
              >
                {visibleEvents.map(({ event, index }) =>
                  renderEvent(event, index, resultMap, sessionId),
                )}
              </PhaseGroup>
            );
          })}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>

      {/* Jump to bottom */}
      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
          }}
          className="absolute bottom-4 right-4 px-3 py-1.5 bg-surface-elevated text-text-secondary text-xs rounded-full
                     shadow-lg hover:bg-surface-hover border border-border-default transition-colors"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}
