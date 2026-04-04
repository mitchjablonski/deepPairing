import { useState } from "react";
import type { ToolCallEvent, ToolResultEvent } from "@deeppairing/shared";

const toolMeta: Record<string, { icon: string; color: string; borderColor: string }> = {
  Read:      { icon: "📄", color: "text-accent-blue",   borderColor: "border-accent-green/40" },
  Glob:      { icon: "🔍", color: "text-accent-blue",   borderColor: "border-accent-green/40" },
  Grep:      { icon: "🔎", color: "text-accent-blue",   borderColor: "border-accent-green/40" },
  Bash:      { icon: "⚡", color: "text-accent-amber",  borderColor: "border-accent-red/40" },
  Edit:      { icon: "✏️", color: "text-accent-amber",   borderColor: "border-accent-amber/40" },
  Write:     { icon: "📝", color: "text-accent-amber",   borderColor: "border-accent-amber/40" },
  WebSearch: { icon: "🌐", color: "text-accent-violet", borderColor: "border-accent-green/40" },
  WebFetch:  { icon: "🌐", color: "text-accent-violet", borderColor: "border-accent-green/40" },
};

function getToolInfo(tool: string) {
  return toolMeta[tool] ?? { icon: "🔧", color: "text-text-muted", borderColor: "border-border-default" };
}

interface ToolCallCardProps {
  toolCall: ToolCallEvent;
  toolResult?: ToolResultEvent;
}

export function ToolCallCard({ toolCall, toolResult }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const info = getToolInfo(toolCall.tool);

  return (
    <div
      className={`border-l-2 ${info.borderColor} bg-surface-elevated rounded-r mb-1 cursor-pointer hover:bg-surface-hover transition-colors`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-sm leading-none">{info.icon}</span>
        <span className={`font-semibold text-xs ${info.color}`}>{toolCall.tool}</span>
        <span className="text-xs text-text-muted truncate flex-1">
          {toolCall.summary ?? JSON.stringify(toolCall.input)}
        </span>
        {toolResult?.duration != null && (
          <span className="text-2xs text-text-muted tabular-nums shrink-0">
            {toolResult.duration}ms
          </span>
        )}
        <span className="text-2xs text-text-muted">{expanded ? "▼" : "▶"}</span>
      </div>

      {expanded && (
        <div className="border-t border-border-subtle px-3 py-2 space-y-2">
          <div>
            <div className="text-2xs font-medium text-text-muted mb-1">Input</div>
            <pre className="text-xs bg-surface-code rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap text-text-secondary font-mono">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>
          {toolResult && (
            <div>
              <div className="text-2xs font-medium text-text-muted mb-1">Output</div>
              <pre className="text-xs bg-surface-code rounded p-2 overflow-auto max-h-60 whitespace-pre-wrap text-text-secondary font-mono">
                {toolResult.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
