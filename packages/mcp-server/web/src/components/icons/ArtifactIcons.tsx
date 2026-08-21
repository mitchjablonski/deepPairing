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

/** #190 — a DEBRIEF is the end-of-feature wrap-up: a clipboard/summary glyph
 *  (a checked-off board) reads as "here's the account of what happened". */
export function ClipboardSummaryIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <path d="M4 2.5H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1v-8a1 1 0 00-1-1h-1" />
      <path d="M5 1.5h4a0.5 0.5 0 01.5.5v1a0.5 0.5 0 01-.5.5H5a0.5 0.5 0 01-.5-.5v-1a0.5 0.5 0 01.5-.5z" />
      <path d="M4.3 7l0.6 0.6 1.1-1.2M8 7h2M4.3 10l0.6 0.6 1.1-1.2M8 10h2" />
    </svg>
  );
}

/** #190 A2 — an EXPLAINER is a guided walk-through: an open book reads as
 *  "here's how this works, narrated". */
export function BookOpenIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <path d="M7 3.5C6 2.7 4.6 2.3 3 2.3c-.6 0-1.1.05-1.5.15v8C1.9 10.35 2.4 10.3 3 10.3c1.6 0 3 .4 4 1.2M7 3.5c1-.8 2.4-1.2 4-1.2.6 0 1.1.05 1.5.15v8c-.4-.1-.9-.15-1.5-.15-1.6 0-3 .4-4 1.2M7 3.5v8" />
    </svg>
  );
}

/**
 * Q4 (round-12 UX #5) — tofu-proof replacements for the three emoji that carry
 * PRIMARY signals. 🛡 (the pre-flight block hero), 🧭 (walk-me-through / ledger
 * writes) and 💬 (comment affordances) render as boxes on any host without a
 * colour-emoji font — which is exactly the moat's loudest moment showing up as
 * a blank square. These are the same 14×14 currentColor strokes as the artifact
 * icons above, so they inherit the accent colour they sit in and never fall
 * back to a font.
 */
export function ShieldIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <path d="M7 1.2L2.2 3v4c0 2.6 1.9 4.8 4.8 5.8 2.9-1 4.8-3.2 4.8-5.8V3L7 1.2z" />
    </svg>
  );
}

export function CompassIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <circle cx="7" cy="7" r="5.6" />
      <path d="M9.3 4.7L8.1 8.1 4.7 9.3 5.9 5.9z" />
    </svg>
  );
}

export function SpeechIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...defaultProps} viewBox="0 0 14 14" className={className}>
      <path d="M12.2 8.2a1.2 1.2 0 01-1.2 1.2H4.4L2 11.8V3a1.2 1.2 0 011.2-1.2h7.8A1.2 1.2 0 0112.2 3v5.2z" />
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
    // #171 — a changeset (a change spanning files) reads as a branch of edits.
    case "changeset": return <GitBranchIcon className={className} />;
    case "reasoning": return <BrainIcon className={className} />;
    case "spec": return <ListChecklistIcon className={className} />;
    // #190 — end-of-feature debrief.
    case "debrief": return <ClipboardSummaryIcon className={className} />;
    // #190 A2 — read-only narrated walk-through.
    case "explainer": return <BookOpenIcon className={className} />;
    default: return <FileTextIcon className={className} />;
  }
}
