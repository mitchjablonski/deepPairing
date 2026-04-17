const defaultProps = { width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <circle cx="6" cy="6" r="4.5" />
      <path d="M9.5 9.5L13 13" />
    </svg>
  );
}

export function FileTextIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <path d="M8 1H3a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V5L8 1z" />
      <path d="M8 1v4h4M5 8h4M5 10h2" />
    </svg>
  );
}

export function GitBranchIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="4" cy="11" r="1.5" />
      <circle cx="10" cy="5" r="1.5" />
      <path d="M4 4.5v5M4 4.5C4 6 6 7 8.5 5" />
    </svg>
  );
}

export function CodeIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <path d="M5 3L1.5 7L5 11M9 3l3.5 4L9 11" />
    </svg>
  );
}

export function BrainIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <path d="M7 13V7M4.5 3.5a2.5 2.5 0 015 0M3 7a2 2 0 014 0M7 7a2 2 0 014 0M4 10.5a2.5 2.5 0 015 0" />
    </svg>
  );
}

export function ScaleIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <path d="M7 2v10M3 4l4-2 4 2M2 8l5-2M7 6l5 2M2 8a2 2 0 004 0M8 8a2 2 0 004 0" />
    </svg>
  );
}

export function ListChecklistIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <path d="M2 3h1M2 7h1M2 11h1M5 3h7M5 7h7M5 11h7" />
      <path d="M2.3 3l0.4 0.4 0.7-0.7M2.3 7l0.4 0.4 0.7-0.7M2.3 11l0.4 0.4 0.7-0.7" />
    </svg>
  );
}

/** Get the icon component for an artifact type */
export function ArtifactIcon({ type, className = "" }: { type: string; className?: string }) {
  switch (type) {
    case "research": return <SearchIcon className={className} />;
    case "plan": return <FileTextIcon className={className} />;
    case "decision": return <ScaleIcon className={className} />;
    case "code_change": return <CodeIcon className={className} />;
    case "reasoning": return <BrainIcon className={className} />;
    case "spec": return <ListChecklistIcon className={className} />;
    default: return <FileTextIcon className={className} />;
  }
}
