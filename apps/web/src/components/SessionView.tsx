import { useState } from "react";
import { useSessionStore } from "../stores/session";

function EventItem({ event }: { event: any }) {
  const [expanded, setExpanded] = useState(false);

  const typeColors: Record<string, string> = {
    text: "#2563eb",
    tool_call: "#d97706",
    tool_result: "#059669",
    thinking: "#7c3aed",
    status: "#6b7280",
    result: "#16a34a",
    error: "#dc2626",
    decision_request: "#e11d48",
    reasoning: "#8b5cf6",
    findings: "#0891b2",
    code_change: "#ea580c",
  };

  const color = typeColors[event.type] ?? "#6b7280";

  return (
    <div
      style={{
        borderLeft: `3px solid ${color}`,
        padding: "8px 12px",
        marginBottom: 4,
        fontSize: 13,
        fontFamily: "monospace",
        cursor: "pointer",
        background: expanded ? "#f9fafb" : "transparent",
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <span style={{ color, fontWeight: 600 }}>[{event.type}]</span>{" "}
      {event.type === "text" && event.content}
      {event.type === "tool_call" && (
        <span>
          {event.tool} — {event.summary ?? JSON.stringify(event.input)}
        </span>
      )}
      {event.type === "tool_result" && (
        <span>
          {event.tool} ({event.duration}ms)
        </span>
      )}
      {event.type === "thinking" && (
        <span style={{ fontStyle: "italic" }}>{event.content.slice(0, 80)}...</span>
      )}
      {event.type === "status" && <span>Phase: {event.phase}</span>}
      {event.type === "result" && <span>{event.content.slice(0, 100)}...</span>}
      {event.type === "error" && (
        <span style={{ color: "#dc2626" }}>{event.message}</span>
      )}
      {event.type === "decision_request" && (
        <span>Decision needed: {event.context}</span>
      )}
      {event.type === "reasoning" && <span>{event.action}</span>}
      {event.type === "findings" && <span>{event.summary}</span>}
      {event.type === "code_change" && (
        <span>
          {event.changeType} {event.filePath}
        </span>
      )}
      {expanded && (
        <pre
          style={{
            marginTop: 8,
            padding: 8,
            background: "#f3f4f6",
            borderRadius: 4,
            overflow: "auto",
            maxHeight: 300,
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {JSON.stringify(event, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function SessionView() {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const { status, events, error, startSession, stopSession, reset } =
    useSessionStore();

  const isActive = status !== "idle" && status !== "completed" && status !== "error";

  const handleSubmit = () => {
    if (!prompt.trim() || !cwd.trim()) return;
    startSession(prompt, cwd);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Input area */}
      <div style={{ padding: 16, borderBottom: "1px solid #e5e7eb" }}>
        <div style={{ marginBottom: 8 }}>
          <input
            type="text"
            placeholder="Project path (e.g., /home/user/my-project)"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            disabled={isActive}
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: 14,
              boxSizing: "border-box",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            placeholder="What would you like to explore?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isActive}
            rows={2}
            style={{
              flex: 1,
              padding: "8px 12px",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: 14,
              resize: "none",
              fontFamily: "system-ui, sans-serif",
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <button
              onClick={handleSubmit}
              disabled={isActive || !prompt.trim() || !cwd.trim()}
              style={{
                padding: "8px 16px",
                background: isActive ? "#9ca3af" : "#2563eb",
                color: "white",
                border: "none",
                borderRadius: 6,
                cursor: isActive ? "default" : "pointer",
                fontSize: 14,
              }}
            >
              Start
            </button>
            {isActive && (
              <button
                onClick={stopSession}
                style={{
                  padding: "8px 16px",
                  background: "#dc2626",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                Stop
              </button>
            )}
            {(status === "completed" || status === "error") && (
              <button
                onClick={reset}
                style={{
                  padding: "8px 16px",
                  background: "#6b7280",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div
        style={{
          padding: "6px 16px",
          background: "#f9fafb",
          borderBottom: "1px solid #e5e7eb",
          fontSize: 13,
          color: "#6b7280",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>
          Status:{" "}
          <strong style={{ color: status === "error" ? "#dc2626" : "#111827" }}>
            {status}
          </strong>
        </span>
        <span>{events.length} events</span>
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: "8px 16px",
            background: "#fef2f2",
            borderBottom: "1px solid #fecaca",
            color: "#dc2626",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* Event stream */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "8px 16px",
        }}
      >
        {events.length === 0 && status === "idle" && (
          <p style={{ color: "#9ca3af", textAlign: "center", marginTop: 40 }}>
            Enter a prompt and project path to start a session
          </p>
        )}
        {events.map((event, i) => (
          <EventItem key={i} event={event} />
        ))}
      </div>
    </div>
  );
}
