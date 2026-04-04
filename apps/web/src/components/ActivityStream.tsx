import { useEffect, useRef, useState } from "react";
import type { AgentEvent, ToolResultEvent } from "@deeppairing/shared";
import { ToolCallCard } from "./ToolCallCard";
import { DecisionCard } from "./DecisionCard";
import { useSessionStore } from "../stores/session";
import { useArtifactStore } from "../stores/artifact";

function TextBlock({ content }: { content: string }) {
  return (
    <div className="px-3 py-2 text-sm text-gray-800 whitespace-pre-wrap">
      {content}
    </div>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="px-3 py-1.5 text-xs text-purple-600 italic cursor-pointer hover:bg-purple-50 rounded"
      onClick={() => setExpanded(!expanded)}
    >
      <span className="font-medium">Thinking...</span>{" "}
      {expanded ? content : `${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`}
    </div>
  );
}

function ResultBlock({ content }: { content: string }) {
  return (
    <div className="mx-3 my-2 p-3 bg-green-50 border border-green-200 rounded-md text-sm text-gray-800 whitespace-pre-wrap">
      <div className="text-xs font-semibold text-green-700 mb-1">Result</div>
      {content}
    </div>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="mx-3 my-2 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
      <div className="text-xs font-semibold text-red-800 mb-1">Error</div>
      {message}
    </div>
  );
}

function StatusDivider({ phase }: { phase: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 my-1">
      <div className="flex-1 border-t border-gray-200" />
      <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">{phase}</span>
      <div className="flex-1 border-t border-gray-200" />
    </div>
  );
}

function FindingsBlock({ event }: { event: AgentEvent & { type: "findings" } }) {
  return (
    <div className="mx-3 my-2 p-3 bg-cyan-50 border border-cyan-200 rounded-md">
      <div className="text-xs font-semibold text-cyan-800 mb-2">Research Findings</div>
      <p className="text-sm text-gray-700 mb-2">{event.summary}</p>
      <div className="space-y-1.5">
        {event.findings.map((f, i) => (
          <div key={i} className="flex items-start gap-2 text-xs">
            <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${
              f.significance === "high" ? "bg-red-100 text-red-700" :
              f.significance === "medium" ? "bg-amber-100 text-amber-700" :
              "bg-gray-100 text-gray-600"
            }`}>
              {f.category}
            </span>
            <span className="text-gray-700">{f.detail}</span>
            <span className="text-gray-400 shrink-0">
              {typeof f.evidence === "string"
                ? f.evidence
                : `${(f.evidence as any[]).length} evidence item(s)`}
            </span>
          </div>
        ))}
      </div>
      {event.openQuestions && event.openQuestions.length > 0 && (
        <div className="mt-2 pt-2 border-t border-cyan-200">
          <div className="text-xs font-medium text-cyan-700 mb-1">Open Questions</div>
          <ul className="text-xs text-gray-600 list-disc list-inside">
            {event.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReasoningBlock({ event }: { event: AgentEvent & { type: "reasoning" } }) {
  return (
    <div className="mx-3 my-1 px-3 py-2 bg-violet-50 border-l-3 border-violet-400 rounded-r-md text-xs">
      <span className="font-semibold text-violet-700">Reasoning:</span>{" "}
      <span className="text-gray-700">{event.action}</span>
      <p className="text-gray-500 mt-0.5">{event.reasoning}</p>
    </div>
  );
}

const artifactTypeIcons: Record<string, string> = {
  research: "🔍",
  plan: "📋",
  decision: "⚖️",
  code_change: "✏️",
  reasoning: "💭",
};

function ArtifactCard({
  type,
  title,
  status,
  artifactId,
}: {
  type: string;
  title: string;
  status: string;
  artifactId: string;
}) {
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);

  return (
    <button
      onClick={() => selectArtifact(artifactId)}
      className="mx-3 my-2 w-[calc(100%-1.5rem)] text-left p-3 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors"
    >
      <div className="flex items-center gap-2">
        <span className="text-base">{artifactTypeIcons[type] ?? "📄"}</span>
        <span className="text-sm font-medium text-indigo-900">{title}</span>
        <span className="ml-auto px-1.5 py-0.5 text-[10px] font-medium bg-indigo-100 text-indigo-700 rounded">
          {status}
        </span>
      </div>
      <p className="text-xs text-indigo-600 mt-1">Click to view in artifact panel →</p>
    </button>
  );
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

export function ActivityStream() {
  const { events, status, sessionId } = useSessionStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const resultMap = buildResultMap(events);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
    }
  }, [events.length, autoScroll]);

  // Detect manual scroll-up to disable auto-scroll
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  };

  if (events.length === 0 && status === "idle") {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Enter a prompt and project path to start a session
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto py-2"
      >
        {events.map((event, i) => {
          switch (event.type) {
            case "text":
              return <TextBlock key={i} content={event.content} />;
            case "tool_call":
              return (
                <div key={i} className="px-3">
                  <ToolCallCard
                    toolCall={event}
                    toolResult={resultMap.get(event.toolCallId)}
                  />
                </div>
              );
            case "tool_result":
              // Rendered as part of ToolCallCard, skip standalone
              return null;
            case "thinking":
              return <ThinkingBlock key={i} content={event.content} />;
            case "status":
              return <StatusDivider key={i} phase={event.phase} />;
            case "result":
              return <ResultBlock key={i} content={event.content} />;
            case "error":
              return <ErrorBlock key={i} message={event.message} />;
            case "findings":
              return <FindingsBlock key={i} event={event} />;
            case "reasoning":
              return <ReasoningBlock key={i} event={event} />;
            case "decision_request":
              return (
                <DecisionCard
                  key={i}
                  event={event}
                  sessionId={sessionId ?? ""}
                />
              );
            case "code_change":
              return (
                <div key={i} className="mx-3 my-1 px-3 py-2 bg-orange-50 border-l-3 border-orange-400 rounded-r-md text-xs">
                  <span className="font-semibold text-orange-700">{event.changeType}</span>{" "}
                  <span className="text-gray-700 font-mono">{event.filePath}</span>
                </div>
              );
            case "artifact_created":
              return (
                <ArtifactCard
                  key={i}
                  type={event.artifact.type}
                  title={event.artifact.title}
                  status={event.artifact.status}
                  artifactId={event.artifact.id}
                />
              );
            case "artifact_updated":
              return (
                <div key={i} className="mx-3 my-1 px-3 py-1.5 bg-blue-50 border-l-3 border-blue-400 rounded-r-md text-xs">
                  <span className="font-semibold text-blue-700">Artifact updated</span>{" "}
                  <span className="text-gray-600">→ {event.status}</span>
                </div>
              );
            case "comment_added":
              return (
                <div key={i} className="mx-3 my-1 px-3 py-1.5 bg-blue-50 border-l-3 border-blue-300 rounded-r-md text-xs">
                  <span className="font-medium text-blue-700">
                    {event.comment.author === "human" ? "You" : "Agent"}
                  </span>{" "}
                  <span className="text-gray-600">commented: {event.comment.content.slice(0, 80)}{event.comment.content.length > 80 ? "..." : ""}</span>
                </div>
              );
            case "plan_review_request":
              return (
                <ArtifactCard
                  key={i}
                  type="plan"
                  title={event.title}
                  status="reviewing"
                  artifactId={event.artifactId}
                />
              );
            default:
              return null;
          }
        })}
        <div ref={bottomRef} />
      </div>

      {/* Jump to bottom button */}
      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
          }}
          className="absolute bottom-4 right-4 px-3 py-1.5 bg-gray-800 text-white text-xs rounded-full
                     shadow-lg hover:bg-gray-700 transition-colors"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}
