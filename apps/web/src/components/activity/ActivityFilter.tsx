interface FilterOption {
  key: string;
  label: string;
  types: string[];
}

const FILTERS: FilterOption[] = [
  { key: "text", label: "Text", types: ["text"] },
  { key: "tools", label: "Tool Calls", types: ["tool_call", "tool_result"] },
  { key: "thinking", label: "Thinking", types: ["thinking"] },
  { key: "decisions", label: "Decisions", types: ["decision_request"] },
  { key: "findings", label: "Findings", types: ["findings"] },
  { key: "artifacts", label: "Artifacts", types: ["artifact_created", "artifact_updated"] },
  { key: "comments", label: "Comments", types: ["comment_added"] },
];

interface ActivityFilterProps {
  hiddenTypes: Set<string>;
  onToggle: (types: string[]) => void;
}

export function ActivityFilter({ hiddenTypes, onToggle }: ActivityFilterProps) {
  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-default bg-surface-secondary overflow-x-auto">
      <span className="text-2xs text-text-muted shrink-0 mr-1">Show:</span>
      {FILTERS.map((filter) => {
        const isHidden = filter.types.some((t) => hiddenTypes.has(t));
        return (
          <button
            key={filter.key}
            onClick={() => onToggle(filter.types)}
            className={`px-2 py-0.5 rounded text-2xs font-medium transition-colors shrink-0 ${
              isHidden
                ? "bg-transparent text-text-muted hover:bg-surface-hover"
                : "bg-surface-elevated text-text-secondary hover:bg-surface-hover"
            }`}
          >
            {filter.label}
          </button>
        );
      })}
    </div>
  );
}

export { FILTERS };
