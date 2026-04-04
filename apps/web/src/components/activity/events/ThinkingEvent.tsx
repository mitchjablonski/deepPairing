import { useState } from "react";

export function ThinkingEvent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="px-3 py-1 text-xs text-accent-violet italic cursor-pointer hover:bg-surface-hover rounded mx-2 transition-colors"
      onClick={() => setExpanded(!expanded)}
    >
      <span className="font-medium">Thinking...</span>{" "}
      {expanded ? content : `${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`}
    </div>
  );
}
