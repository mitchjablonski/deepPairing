import { useState } from "react";
import type { ToolCallEvent, ToolResultEvent } from "@deeppairing/shared";

const toolMeta: Record<string, { icon: string; color: string; riskColor: string }> = {
  Read:      { icon: "📄", color: "text-blue-700",   riskColor: "border-green-400" },
  Glob:      { icon: "🔍", color: "text-blue-600",   riskColor: "border-green-400" },
  Grep:      { icon: "🔎", color: "text-blue-600",   riskColor: "border-green-400" },
  Bash:      { icon: "⚡", color: "text-amber-700",  riskColor: "border-red-400" },
  Edit:      { icon: "✏️", color: "text-orange-700",  riskColor: "border-yellow-400" },
  Write:     { icon: "📝", color: "text-orange-600",  riskColor: "border-yellow-400" },
  WebSearch: { icon: "🌐", color: "text-purple-700", riskColor: "border-green-400" },
  WebFetch:  { icon: "🌐", color: "text-purple-600", riskColor: "border-green-400" },
};

function getToolInfo(tool: string) {
  return toolMeta[tool] ?? { icon: "🔧", color: "text-gray-700", riskColor: "border-gray-400" };
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
      className={`border-l-3 ${info.riskColor} bg-white rounded-r-md mb-1.5 cursor-pointer hover:bg-gray-50 transition-colors`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-base leading-none">{info.icon}</span>
        <span className={`font-semibold text-xs ${info.color}`}>{toolCall.tool}</span>
        <span className="text-xs text-gray-500 truncate flex-1">
          {toolCall.summary ?? JSON.stringify(toolCall.input)}
        </span>
        {toolResult?.duration != null && (
          <span className="text-xs text-gray-400 tabular-nums shrink-0">
            {toolResult.duration}ms
          </span>
        )}
        <span className="text-xs text-gray-300">{expanded ? "▼" : "▶"}</span>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 px-3 py-2 space-y-2">
          <div>
            <div className="text-xs font-medium text-gray-500 mb-1">Input</div>
            <pre className="text-xs bg-gray-50 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>
          {toolResult && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-1">Output</div>
              <pre className="text-xs bg-gray-50 rounded p-2 overflow-auto max-h-60 whitespace-pre-wrap">
                {toolResult.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
