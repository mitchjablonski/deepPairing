import type { Artifact, Evidence, Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { FileViewer } from "./FileViewer";
import { CommentableCode } from "../CommentableCode";
import { CommentTrigger, AskTrigger } from "../CommentThread";
import { OpenInEditorLink } from "../OpenInEditor";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { useState, useMemo, useEffect, useRef } from "react";

interface ResearchArtifactProps {
  artifact: Artifact;
}

interface RichFinding {
  category: string;
  title?: string;
  detail: string;
  evidence: string | Evidence[];
  significance: "low" | "medium" | "high";
  severity?: "info" | "low" | "medium" | "high" | "critical";
  confidence?: "low" | "medium" | "high";
  impact?: string;
  recommendation?: string;
}

const severityStyles: Record<string, string> = {
  info: "bg-surface-elevated text-text-muted border border-white/[0.06]",
  low: "bg-accent-green-dim text-accent-green",
  medium: "bg-accent-amber-dim text-accent-amber",
  high: "bg-accent-red-dim text-accent-red",
  critical: "bg-accent-red text-white",
};

const severityLabels: Record<string, string> = {
  info: "info",
  low: "low risk",
  medium: "medium risk",
  high: "high risk",
  critical: "critical",
};

const sigColors: Record<string, string> = {
  high: "bg-accent-red-dim text-accent-red",
  medium: "bg-accent-amber-dim text-accent-amber",
  low: "bg-surface-elevated text-text-secondary",
};

const categoryColors: Record<string, string> = {
  security: "bg-accent-red-dim text-accent-red",
  architecture: "bg-accent-violet-dim text-accent-violet",
  performance: "bg-accent-amber-dim text-accent-amber",
  testing: "bg-accent-cyan-dim text-accent-cyan",
  infrastructure: "bg-accent-blue-dim text-accent-blue",
  "code quality": "bg-accent-green-dim text-accent-green",
  domain: "bg-accent-violet-dim text-accent-violet",
};

function getCategoryColor(category: string): string {
  const lower = category.toLowerCase();
  // Check for partial matches (e.g., "Domain / Why This Exists" matches "domain")
  for (const [key, color] of Object.entries(categoryColors)) {
    if (lower.includes(key)) return color;
  }
  return "bg-accent-blue-dim text-accent-blue";
}

type ColorBy = "significance" | "category";

type Verdict = "approved" | "revised" | "rejected";

/**
 * Per-finding triage chips. When auditing a research artifact with many
 * findings, binary artifact-level Approve/Revise is too coarse — you want
 * to accept findings 1, 3, 5 and push back on 2 and 4. This submits a
 * finding-scoped comment the agent can use when supersedes.
 */
function FindingTriage({
  artifactId,
  findingIndex,
  findingTitle,
  comments,
}: {
  artifactId: string;
  findingIndex: number;
  findingTitle: string;
  comments: Comment[];
}) {
  const [promptVerdict, setPromptVerdict] = useState<Verdict | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { submitComment } = useArtifactStore();

  // Look up any existing verdict (latest one with sectionId === "verdict")
  const latestVerdict = useMemo<Verdict | null>(() => {
    const verdicts = comments.filter((c) => (c.target as any).sectionId === "verdict");
    const newest = verdicts[verdicts.length - 1];
    if (!newest) return null;
    const content = newest.content.toLowerCase();
    if (content.startsWith("approved")) return "approved";
    if (content.startsWith("needs revision")) return "revised";
    if (content.startsWith("rejected")) return "rejected";
    return null;
  }, [comments]);

  const submit = async (verdict: Verdict, reasonText = "") => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const label =
        verdict === "approved" ? "Approved" :
        verdict === "revised" ? "Needs revision" :
        "Rejected";
      const body = reasonText.trim() ? `${label}: ${reasonText.trim()}` : `${label} — finding #${findingIndex + 1}`;
      await submitComment(
        artifactId,
        body,
        { findingIndex, sectionId: "verdict" } as any,
      );
      setPromptVerdict(null);
      setReason("");
    } finally {
      setSubmitting(false);
    }
  };

  const chipClass = (active: boolean, tone: "green" | "amber" | "red") => {
    const base = "w-5 h-5 flex items-center justify-center rounded text-[10px] font-semibold transition-colors press-scale";
    if (active) {
      return `${base} ${
        tone === "green" ? "bg-accent-green text-white" :
        tone === "amber" ? "bg-accent-amber text-white" :
        "bg-accent-red text-white"
      }`;
    }
    return `${base} text-text-muted hover:text-text-primary ${
      tone === "green" ? "hover:bg-accent-green-dim" :
      tone === "amber" ? "hover:bg-accent-amber-dim" :
      "hover:bg-accent-red-dim"
    }`;
  };

  return (
    <div className="relative flex items-center gap-0.5">
      <button
        onClick={() => submit("approved")}
        disabled={submitting}
        aria-label={`Approve finding ${findingIndex + 1}`}
        title={`Approve — "${findingTitle.slice(0, 60)}"`}
        className={chipClass(latestVerdict === "approved", "green")}
      >
        ✓
      </button>
      <button
        onClick={() => {
          setPromptVerdict("revised");
          setReason("");
        }}
        disabled={submitting}
        aria-label={`Request revision on finding ${findingIndex + 1}`}
        title="Request revision — needs a reason"
        className={chipClass(latestVerdict === "revised", "amber")}
      >
        ↻
      </button>
      <button
        onClick={() => {
          setPromptVerdict("rejected");
          setReason("");
        }}
        disabled={submitting}
        aria-label={`Reject finding ${findingIndex + 1}`}
        title="Reject — needs a reason"
        className={chipClass(latestVerdict === "rejected", "red")}
      >
        ✗
      </button>

      {promptVerdict && (
        <div className="absolute top-full right-0 mt-1 p-2 bg-surface-elevated border border-border-default rounded-lg shadow-lg z-10 w-72">
          <div className="text-2xs text-text-muted mb-1.5">
            {promptVerdict === "revised" ? "Why should the agent revise?" : "Why reject?"}
          </div>
          <textarea
            rows={2}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reason.trim()) {
                e.preventDefault();
                submit(promptVerdict, reason);
              }
              if (e.key === "Escape") {
                setPromptVerdict(null);
                setReason("");
              }
            }}
            placeholder={`Reason (${promptVerdict === "revised" ? "agent redrafts this finding" : "remembered across sessions"})…`}
            className="w-full px-2 py-1.5 bg-surface-secondary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none"
          />
          <div className="flex gap-1.5 mt-1.5 justify-end">
            <button
              onClick={() => { setPromptVerdict(null); setReason(""); }}
              className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary"
            >
              Cancel
            </button>
            <button
              onClick={() => submit(promptVerdict, reason)}
              disabled={!reason.trim() || submitting}
              className={`px-2 py-1 text-2xs text-white rounded press-scale disabled:opacity-50 ${
                promptVerdict === "revised" ? "bg-accent-amber hover:bg-accent-amber/80" : "bg-accent-red hover:bg-accent-red/80"
              }`}
            >
              {promptVerdict === "revised" ? "Request revision" : "Reject"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FindingLegend({ colorBy, findings }: { colorBy: ColorBy; findings: RichFinding[] }) {
  if (colorBy === "significance") {
    return (
      <div className="flex items-center gap-3 text-2xs text-text-muted">
        <span className="text-text-muted">Color:</span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded bg-accent-red" /> High
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded bg-accent-amber" /> Medium
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded bg-text-muted" /> Low
        </span>
      </div>
    );
  }

  // Category mode — show unique categories found in findings
  const categories = [...new Set(findings.map((f) => f.category).filter(Boolean))];
  return (
    <div className="flex items-center gap-3 text-2xs text-text-muted flex-wrap">
      <span className="text-text-muted">Color:</span>
      {categories.map((cat) => (
        <span key={cat} className="flex items-center gap-1">
          <span className={`w-2 h-2 rounded ${getCategoryColor(cat).split(" ")[0]}`} />
          {cat}
        </span>
      ))}
    </div>
  );
}

function EvidenceItem({
  evidence,
  artifactId,
  findingIndex,
  evidenceIndex,
  allComments,
}: {
  evidence: Evidence;
  artifactId: string;
  findingIndex: number;
  evidenceIndex: number;
  allComments: Comment[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [showFullFile, setShowFullFile] = useState(false);

  // Build a map of comments by line number for this evidence.
  //
  // Span comments (lineStart != lineEnd) bucket into EVERY line in the
  // range. CommentableCode then renders the full comment chip on the
  // start line and a compact "↳ continues from L{N}" marker on
  // subsequent lines — so a comment spanning lines 5-8 is visible on all
  // four lines, not just line 5 (which was the visibility bug).
  //
  // Defensive: a single malformed comment target (string lineStart,
  // negative range, undefined fields, etc.) must not blow up the entire
  // artifact render. Coerce-and-validate per comment, skip the bad one,
  // keep going.
  const commentsByLine = useMemo(() => {
    const map = new Map<number, Comment[]>();
    for (const c of allComments) {
      try {
        if (
          c.target?.findingIndex !== findingIndex ||
          c.target?.evidenceIndex !== evidenceIndex ||
          c.target?.lineStart == null
        ) continue;
        const startN = Number(c.target.lineStart);
        const endRaw = (c.target as any).lineEnd;
        const endN = endRaw == null ? startN : Number(endRaw);
        // Skip bad numerics rather than crashing the render.
        if (!Number.isFinite(startN) || !Number.isFinite(endN)) continue;
        const start = Math.max(0, Math.floor(startN));
        const end = Math.max(start, Math.floor(endN));
        // Cap span at 200 lines so a runaway lineEnd can't blow the Map up.
        const safeEnd = Math.min(end, start + 200);
        for (let line = start; line <= safeEnd; line++) {
          const existing = map.get(line) ?? [];
          existing.push(c);
          map.set(line, existing);
        }
      } catch {
        // Ignore one bad comment; keep rendering the rest of the artifact.
      }
    }
    return map;
  }, [allComments, findingIndex, evidenceIndex]);

  return (
    <>
      {showFullFile && (
        <FileViewer
          filePath={evidence.filePath}
          highlightStart={evidence.lineStart}
          highlightEnd={evidence.lineEnd}
          artifactId={artifactId}
          onClose={() => setShowFullFile(false)}
        />
      )}
      <div className="mt-2 rounded-md overflow-hidden border border-border-default">
        {/* File header */}
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-surface-elevated text-xs">
          <span className="font-mono text-text-secondary flex items-center gap-1.5">
            {evidence.filePath}:{evidence.lineStart}-{evidence.lineEnd}
            <OpenInEditorLink filePath={evidence.filePath} line={evidence.lineStart} />
          </span>
          <div className="flex items-center gap-2">
            <AskTrigger
              artifactId={artifactId}
              target={{ findingIndex, evidenceIndex }}
            />
            <button
              onClick={() => setShowFullFile(true)}
              className="text-text-muted hover:text-accent-blue transition-colors"
              title="Open full file"
            >
              Open file
            </button>
            {evidence.relatedPaths && evidence.relatedPaths.length > 0 && (
              <span className="text-text-muted">+{evidence.relatedPaths.length} related</span>
            )}
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-text-muted hover:text-text-muted"
            >
              {expanded ? "▼" : "▶"}
            </button>
          </div>
        </div>

        {/* Commentable code snippet — hover line to see +, click to comment */}
        {evidence.snippet && (
          <CommentableCode
            code={evidence.snippet}
            language={evidence.language}
            lineStart={evidence.lineStart}
            filePath={evidence.filePath}
            artifactId={artifactId}
            commentsByLine={commentsByLine}
            targetContext={{ findingIndex, evidenceIndex }}
          />
        )}

        {/* Explanation */}
        <div className="px-3 py-2 bg-accent-amber-dim/80 border-t border-border-default/20 text-xs text-text-secondary">
          {evidence.explanation}
        </div>

        {/* Expanded: context + related paths */}
        {expanded && (
          <>
            {evidence.context && (
              <div className="border-t border-border-default">
                <div className="px-2.5 py-1 bg-surface-elevated text-[10px] font-semibold text-text-muted uppercase">
                  Full Context
                </div>
                <CommentableCode
                  code={evidence.context}
                  lineStart={1}
                  filePath={evidence.filePath}
                  artifactId={artifactId}
                  targetContext={{ findingIndex, evidenceIndex }}
                />
              </div>
            )}
            {evidence.relatedPaths && evidence.relatedPaths.length > 0 && (
              <div className="px-3 py-2 border-t border-border-default text-xs bg-surface-secondary">
                <span className="font-medium text-text-muted">Also appears in: </span>
                {evidence.relatedPaths.map((p) => (
                  <span key={p} className="inline-block px-1.5 py-0.5 bg-gray-200 rounded font-mono text-text-secondary mr-1">
                    {p}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function renderEvidence(
  evidence: unknown,
  artifactId: string,
  findingIndex: number,
  allComments: Comment[],
) {
  // Guard: missing or null evidence
  if (!evidence) return null;

  // String evidence (simple reference)
  if (typeof evidence === "string") {
    return <p className="text-text-muted mt-0.5 font-mono text-[11px]">{evidence}</p>;
  }

  // Normalize: single object → wrap in array
  const evidenceArray = Array.isArray(evidence) ? evidence : [evidence];

  return (
    <div className="space-y-1">
      {evidenceArray.map((ev, evIdx) => {
        // Guard: skip items that don't look like Evidence objects
        if (!ev || typeof ev !== "object" || !("filePath" in ev)) {
          return (
            <p key={evIdx} className="text-text-muted mt-0.5 font-mono text-[11px]">
              {JSON.stringify(ev)}
            </p>
          );
        }
        return (
          <EvidenceItem
            key={evIdx}
            evidence={ev as Evidence}
            artifactId={artifactId}
            findingIndex={findingIndex}
            evidenceIndex={evIdx}
            allComments={allComments}
          />
        );
      })}
    </div>
  );
}

export function ResearchArtifact({ artifact }: ResearchArtifactProps) {
  // Defensive: artifact.content can drift in the wild (older sessions,
  // partial writes, malformed agent output). Coerce to an object and
  // skip non-object findings so one bad entry can't ErrorBoundary the
  // whole artifact.
  const rawContent = (artifact.content && typeof artifact.content === "object")
    ? (artifact.content as Record<string, unknown>)
    : {};
  const content = {
    summary: typeof rawContent.summary === "string" ? rawContent.summary : undefined,
    findings: Array.isArray(rawContent.findings)
      ? (rawContent.findings as any[]).filter((f) => f && typeof f === "object") as RichFinding[]
      : [],
    openQuestions: Array.isArray(rawContent.openQuestions)
      ? (rawContent.openQuestions as any[]).filter((q) => typeof q === "string") as string[]
      : undefined,
  };
  const comments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];
  const [focusMode, setFocusMode] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [colorBy, setColorBy] = useState<ColorBy>("significance");
  const findings = content.findings;
  const focusRef = useRef<HTMLDivElement>(null);

  // Arrow key navigation in focus mode
  useEffect(() => {
    if (!focusMode) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex((i) => Math.min(findings.length - 1, i + 1));
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [focusMode, findings.length]);

  const renderFinding = (finding: RichFinding, i: number) => {
    const findingComments = comments.filter(
      (c) => c.target.findingIndex === i && c.target.evidenceIndex == null && c.target.lineStart == null,
    );
    return (
      <div
        key={i}
        className={`bg-surface-secondary rounded-lg border border-white/[0.06] hover:border-white/[0.1] transition-all duration-[180ms] ease-out ${
          focusMode ? "p-5" : "p-3"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-medium ${
              colorBy === "significance"
                ? (sigColors[finding.significance] ?? "bg-surface-elevated text-text-secondary")
                : getCategoryColor(finding.category ?? "")
            }`}>
              {finding.category ?? "Finding"}
            </span>
            {finding.title && (
              <span className={`font-semibold text-text-primary ${focusMode ? "text-base" : "text-sm"}`}>{finding.title}</span>
            )}
            {finding.severity && (
              <span
                className={`shrink-0 px-1.5 py-0.5 rounded text-2xs font-semibold ${severityStyles[finding.severity]}`}
                title="Severity — risk level if unaddressed"
              >
                {severityLabels[finding.severity]}
              </span>
            )}
            {finding.confidence && finding.confidence !== "medium" && (
              <span className={`shrink-0 px-1.5 py-0.5 rounded text-2xs font-medium ${
                finding.confidence === "low"
                  ? "bg-accent-amber-dim text-accent-amber border border-dashed border-accent-amber/30"
                  : "bg-accent-green-dim text-accent-green"
              }`}>
                {finding.confidence === "low" ? "? uncertain" : "✓ confident"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <FindingTriage
              artifactId={artifact.id}
              findingIndex={i}
              findingTitle={finding.title ?? finding.detail}
              comments={findingComments}
            />
            <AskTrigger
              artifactId={artifact.id}
              target={{ findingIndex: i }}
            />
            <CommentTrigger
              artifactId={artifact.id}
              target={{ findingIndex: i }}
              existingCount={findingComments.length}
            />
          </div>
        </div>

        {/* Detail */}
        <SimpleMarkdown text={finding.detail} className={`text-text-secondary mt-2 space-y-2 ${focusMode ? "text-sm leading-relaxed" : "text-xs"}`} />

        {/* Evidence — now with inline commenting on code lines */}
        {renderEvidence(finding.evidence, artifact.id, i, comments)}

        {/* Impact */}
        {finding.impact && (
          <div className="mt-3 p-2.5 bg-accent-red-dim/50 border-l-2 border-accent-red rounded-r">
            <span className={`font-semibold text-accent-red block mb-0.5 ${focusMode ? "text-sm" : "text-xs"}`}>Impact</span>
            <SimpleMarkdown text={finding.impact} className={`text-accent-red/80 ${focusMode ? "text-sm" : "text-xs"}`} />
          </div>
        )}

        {/* Recommendation */}
        {finding.recommendation && (
          <div className="mt-2 p-2.5 bg-accent-green-dim/50 border-l-2 border-accent-green rounded-r">
            <span className={`font-semibold text-accent-green block mb-0.5 ${focusMode ? "text-sm" : "text-xs"}`}>Recommendation</span>
            <SimpleMarkdown text={finding.recommendation} className={`text-accent-green/80 ${focusMode ? "text-sm" : "text-xs"}`} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {content.summary && (
        <SimpleMarkdown text={content.summary} className="text-sm text-text-secondary space-y-2" />
      )}

      {findings.length > 0 && (
        <div className="space-y-3">
          {/* Header with view toggle and color mode */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                Findings ({findings.length})
              </h4>
              <div className="flex items-center gap-2">
                {/* Color by toggle */}
                <div className="flex items-center gap-0.5 bg-surface-elevated rounded p-0.5">
                  <button
                    onClick={() => setColorBy("significance")}
                    className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                      colorBy === "significance" ? "bg-surface-hover text-text-primary" : "text-text-muted"
                    }`}
                  >
                    Severity
                  </button>
                  <button
                    onClick={() => setColorBy("category")}
                    className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                      colorBy === "category" ? "bg-surface-hover text-text-primary" : "text-text-muted"
                    }`}
                  >
                    Category
                  </button>
                </div>
                {/* View mode toggle */}
                {findings.length > 1 && (
                  <div className="flex items-center gap-0.5 bg-surface-elevated rounded p-0.5">
                    <button
                      onClick={() => { setFocusMode(false); }}
                      className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                        !focusMode ? "bg-surface-hover text-text-primary" : "text-text-muted"
                      }`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => { setFocusMode(true); setFocusIndex(0); }}
                      className={`px-2 py-0.5 rounded text-2xs transition-colors ${
                        focusMode ? "bg-surface-hover text-text-primary" : "text-text-muted"
                      }`}
                    >
                      Focus
                    </button>
                  </div>
                )}
              </div>
            </div>
            {/* Legend */}
            <FindingLegend colorBy={colorBy} findings={findings} />
          </div>

          {focusMode ? (
            /* Focus mode: one finding at a time with navigation */
            <div className="space-y-3">
              {/* Navigation */}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setFocusIndex((i) => Math.max(0, i - 1))}
                  disabled={focusIndex === 0}
                  className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary disabled:opacity-30 press-scale"
                >
                  Prev
                </button>
                <span className="text-2xs text-text-muted">
                  {focusIndex + 1} / {findings.length}
                  {findings[focusIndex]?.title && (
                    <span className="text-text-secondary ml-1.5">— {findings[focusIndex].title}</span>
                  )}
                </span>
                <button
                  onClick={() => setFocusIndex((i) => Math.min(findings.length - 1, i + 1))}
                  disabled={focusIndex === findings.length - 1}
                  className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary disabled:opacity-30 press-scale"
                >
                  Next
                </button>
              </div>

              {renderFinding(findings[focusIndex], focusIndex)}

              {/* Dot indicators */}
              <div className="flex items-center justify-center gap-1.5">
                {findings.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setFocusIndex(i)}
                    className={`w-1.5 h-1.5 rounded-full transition-colors ${
                      i === focusIndex ? "bg-accent-blue" : "bg-surface-hover"
                    }`}
                  />
                ))}
              </div>
            </div>
          ) : (
            /* List mode: all findings */
            <div className="space-y-4">
              {findings.map((finding, i) => renderFinding(finding, i))}
            </div>
          )}
        </div>
      )}

      {content.openQuestions && content.openQuestions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
            Open Questions
          </h4>
          <ul className="text-xs text-text-secondary space-y-1">
            {content.openQuestions.map((q, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-accent-amber mt-0.5">?</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
