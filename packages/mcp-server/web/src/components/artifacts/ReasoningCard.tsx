import { useMemo, useState } from "react";
import {
  type Artifact,
  type ReasoningContent,
  type Evidence,
  getTypedContent,
} from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { OpenInEditorLink } from "../OpenInEditor";

interface Props {
  artifact: Artifact;
}

/**
 * First-class viewer for `reasoning` artifacts — the "show your work"
 * pairing surface.
 *
 * Layout (top → bottom):
 *   1. Action line (the intent, prominent).
 *   2. Named concept card (when present) — THE teaching moment. Agents are
 *      instructed to surface the underlying concept name; this card puts it
 *      front and center so the reader learns the pattern, not just the fix.
 *   3. Why prose (markdown, expandable when long).
 *   4. Related artifact badge (when relatesTo is set).
 *   5. Rejected alternatives, each with an "Ask why" button that posts a
 *      follow-up question comment back to the agent.
 *   6. Evidence strip: files/lines that motivated this reasoning step.
 */
export function ReasoningCard({ artifact }: Props) {
  const rc = getTypedContent<ReasoningContent>(artifact);
  const { artifacts, selectArtifact, submitComment } = useArtifactStore();

  const relatedArtifact = useMemo(
    () => (rc.relatesTo ? artifacts.find((a) => a.id === rc.relatesTo?.artifactId) : undefined),
    [rc.relatesTo, artifacts],
  );

  return (
    <div className="space-y-4">
      {/* Action — the intent, rendered as a prominent thought */}
      <div className="relative px-4 py-3 bg-accent-blue-dim/25 border border-accent-blue/20 rounded-lg">
        <div className="text-xs font-medium text-accent-blue/90 mb-1">
          What I'm about to do
        </div>
        <SimpleMarkdown
          text={rc.action}
          className="text-sm text-text-primary font-medium space-y-1"
        />
        {rc.confidence && (
          <span
            className={`absolute top-3 right-3 inline-block px-1.5 py-0.5 text-2xs font-medium rounded ${
              rc.confidence === "high"
                ? "bg-accent-green-dim text-accent-green"
                : rc.confidence === "low"
                  ? "bg-accent-amber-dim text-accent-amber"
                  : "bg-surface-elevated text-text-secondary"
            }`}
          >
            {rc.confidence} confidence
          </span>
        )}
      </div>

      {/* Named concept — the pairing-learning hook */}
      {rc.concept?.name && (
        <ConceptCallout
          name={rc.concept.name}
          explanation={rc.concept.oneLineExplanation}
        />
      )}

      {/* Why prose */}
      <div>
        <div className="text-xs font-medium text-text-secondary mb-1.5">
          Because…
        </div>
        <SimpleMarkdown
          text={rc.reasoning}
          className="text-sm text-text-secondary space-y-2"
        />
      </div>

      {/* Relates to → another artifact */}
      {rc.relatesTo && relatedArtifact && (
        <button
          onClick={() => selectArtifact(relatedArtifact.id)}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-2xs
                     bg-surface-elevated border border-border-subtle text-text-secondary
                     hover:border-accent-blue hover:text-accent-blue transition-colors"
          title="Jump to the related artifact"
        >
          <span className="opacity-60">{rc.relatesTo.kind}</span>
          <span className="font-medium">→ {relatedArtifact.title}</span>
        </button>
      )}

      {/* Rejected alternatives — forks-not-taken */}
      {rc.alternativeDetails && rc.alternativeDetails.length > 0 && (
        <div>
          <div className="text-xs font-medium text-text-secondary mb-1.5">
            Roads not taken
          </div>
          <div className="space-y-2">
            {rc.alternativeDetails.map((alt, i) => (
              <AlternativeRow
                key={i}
                artifactId={artifact.id}
                alt={alt}
                onAskWhy={(question) =>
                  submitComment(
                    artifact.id,
                    question,
                    { alternativeIndex: i },
                    { intent: "question" },
                  )
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* Legacy flat alternatives, if the agent didn't supply structured ones */}
      {(!rc.alternativeDetails?.length) &&
        rc.alternativesConsidered &&
        rc.alternativesConsidered.length > 0 && (
          <div className="text-xs text-text-muted">
            <strong className="text-text-secondary">Alternatives:</strong>{" "}
            {rc.alternativesConsidered.join(", ")}
          </div>
        )}

      {/* Evidence strip */}
      {rc.evidence && rc.evidence.length > 0 && (
        <div>
          <div className="text-xs font-medium text-text-secondary mb-1.5">
            I looked at
          </div>
          <div className="space-y-1.5">
            {rc.evidence.map((ev, i) => (
              <EvidenceChip key={i} evidence={ev} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ConceptCallout({
  name,
  explanation,
}: {
  name: string;
  explanation?: string;
}) {
  return (
    <div className="px-4 py-3 bg-accent-violet-dim/30 border border-accent-violet/25 rounded-lg">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-accent-violet/90">
          The pattern at play
        </span>
      </div>
      <div className="text-sm font-semibold text-accent-violet mb-0.5">{name}</div>
      {explanation && (
        <div className="text-xs text-text-secondary leading-relaxed">{explanation}</div>
      )}
    </div>
  );
}

function AlternativeRow({
  alt,
  onAskWhy,
}: {
  artifactId: string;
  alt: { title: string; reason: string };
  onAskWhy: (question: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [sent, setSent] = useState(false);

  const send = async () => {
    const trimmed = question.trim();
    if (!trimmed) return;
    await onAskWhy(trimmed);
    setSent(true);
    setQuestion("");
    setAsking(false);
    setTimeout(() => setSent(false), 2000);
  };

  return (
    <div className="flex items-start gap-2 px-3 py-2 bg-surface-elevated border border-white/[0.06] rounded-lg">
      <span className="text-accent-red text-xs mt-0.5 shrink-0">&#x2717;</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-text-secondary line-through opacity-70">
            {alt.title}
          </div>
          {!asking && (
            <button
              onClick={() => setAsking(true)}
              className="shrink-0 text-2xs text-accent-violet hover:text-accent-violet/80 font-medium transition-colors"
              title="Ask the agent a follow-up about this alternative"
            >
              {sent ? "Asked ✓" : "Ask why"}
            </button>
          )}
        </div>
        <div className="text-2xs text-text-muted mt-0.5">{alt.reason}</div>
        {asking && (
          <div className="mt-2 flex gap-1.5">
            <input
              type="text"
              autoFocus
              placeholder={`Ask about "${alt.title}"...`}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape") {
                  setAsking(false);
                  setQuestion("");
                }
              }}
              className="flex-1 px-2 py-1 bg-surface-primary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet"
            />
            <button
              onClick={send}
              disabled={!question.trim()}
              className="px-2 py-1 bg-accent-violet text-white text-2xs rounded hover:bg-accent-violet/80 disabled:opacity-50 press-scale"
            >
              Ask
            </button>
            <button
              onClick={() => {
                setAsking(false);
                setQuestion("");
              }}
              className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EvidenceChip({ evidence }: { evidence: Evidence | string }) {
  if (typeof evidence === "string") {
    return (
      <div className="px-2 py-1 bg-surface-elevated rounded text-2xs font-mono text-text-secondary">
        {evidence}
      </div>
    );
  }
  return (
    <div className="rounded border border-border-default overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 bg-surface-elevated text-2xs">
        <span className="font-mono text-text-secondary flex items-center gap-1.5 truncate">
          <span className="truncate">
            {evidence.filePath}:{evidence.lineStart}
            {evidence.lineEnd !== evidence.lineStart ? `-${evidence.lineEnd}` : ""}
          </span>
          <OpenInEditorLink filePath={evidence.filePath} line={evidence.lineStart} />
        </span>
      </div>
      {evidence.snippet && (
        <pre className="px-2 py-1 text-2xs text-text-secondary bg-surface-primary overflow-x-auto font-mono whitespace-pre">
          {evidence.snippet}
        </pre>
      )}
      {evidence.explanation && (
        <div className="px-2 py-1 border-t border-border-default text-2xs text-text-muted">
          {evidence.explanation}
        </div>
      )}
    </div>
  );
}
