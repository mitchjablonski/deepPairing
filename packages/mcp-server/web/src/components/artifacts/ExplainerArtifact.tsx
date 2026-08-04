import { useMemo, useState, type ReactNode } from "react";
import type { Artifact, Comment, ExplainerContent } from "@deeppairing/shared";
import { coerceExplainerContent } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useChainComments } from "../../hooks/useChainComments";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { CommentThread } from "../CommentThread";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { renderEvidence } from "./ResearchArtifact";

/**
 * #190 A2 — the read-only EXPLAINER renderer (the comprehension surface for how
 * code WORKS, not what's wrong with it).
 *
 * A narrated, ordered walk-through: an overview ("what you're about to read"),
 * then numbered sections read top-to-bottom, each anchored to real Evidence and
 * an ask-anything thread at the bottom. Deliberately NO problem-framing (no
 * severity/significance/recommendation) — that's present_findings' job.
 *
 * Reuse, not rebuild:
 *   - evidence → renderEvidence/EvidenceItem exported from ResearchArtifact (the
 *     exact Evidence + CommentableCode + FileViewer wiring — per-line commenting
 *     works with zero new code).
 *   - the ask-anything + per-block grain composers → CommentThread.
 *   - the unified verb triad → ArtifactStatusActions.
 *
 * Grain commenting: every block is commentable at a sectionId grain the server
 * delivery layer already parses (its OWN `explainer:*` namespace) — EXACTLY:
 *   - overview       → `explainer:overview`
 *   - the walk[i]    → `explainer:<i>`  (0-based)
 */

interface ExplainerArtifactProps {
  artifact: Artifact;
}

/** Focus/select an underlying artifact from a drill-in link. Prefers the store
 *  action (directly testable) and also dispatches the app-wide focus event
 *  App.tsx listens for, so the selection works from any surface. */
function focusArtifact(id: string): void {
  useArtifactStore.getState().selectArtifact(id);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: id } }));
  }
}

/** A drill-in link to a related artifact. Clicking SELECTS it in the panel. */
function ArtifactRefLink({ id, label }: { id: string; label?: string }) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const title = artifacts.find((a) => a.id === id)?.title;
  return (
    <button
      type="button"
      onClick={() => focusArtifact(id)}
      data-testid="explainer-artifact-ref"
      className="inline-flex items-center gap-1 px-2 py-0.5 bg-surface-elevated border border-border-subtle
                 rounded text-2xs text-text-secondary hover:border-accent-blue hover:text-accent-blue transition-colors"
      title={`Open ${title ?? id}`}
    >
      <span aria-hidden="true">↗</span>
      {label ?? title ?? id}
    </button>
  );
}

/**
 * A lightweight per-block grain-comment surface — the same distilled pattern the
 * debrief uses: renders the block's existing grain thread (if any) and a
 * "💬 Comment" toggle that reveals a scoped CommentThread posting to
 * `{ artifactId, sectionId }`.
 */
function BlockGrain({
  artifactId,
  sectionId,
  label,
  comments,
}: {
  artifactId: string;
  sectionId: string;
  label: string;
  comments: Comment[];
}) {
  const grain = useMemo(
    () => comments.filter((c) => c.target.sectionId === sectionId),
    [comments, sectionId],
  );
  const [open, setOpen] = useState(false);
  const show = open || grain.length > 0;

  return (
    <div className="mt-2">
      {!show && (
        <button
          type="button"
          data-grain-affordance
          onClick={() => setOpen(true)}
          aria-label={`Comment on ${label}`}
          className="inline-flex items-center gap-1 text-2xs text-text-muted hover:text-accent-blue transition-colors press-scale"
        >
          <span aria-hidden="true">💬</span> Comment
        </button>
      )}
      {show && (
        <div className="rounded-lg border border-border-default bg-surface-elevated p-2.5">
          <div className="text-2xs uppercase tracking-wide text-text-muted font-semibold mb-1.5">
            Comment on {label}
          </div>
          <CommentThread
            artifactId={artifactId}
            comments={grain}
            target={{ artifactId, sectionId }}
            placeholder={`Comment on ${label} — the agent sees it anchored here…`}
            submitLabel="Comment"
            textareaLabel={`Comment on ${label}`}
            secondarySubmitLabel="Ask"
            secondarySubmitTitle={`Ask the agent a question about ${label}`}
          />
        </div>
      )}
    </div>
  );
}

/** A titled block wrapper: heading + content + its grain-comment surface. */
function ExplainerBlock({
  artifactId,
  sectionId,
  title,
  comments,
  children,
}: {
  artifactId: string;
  sectionId: string;
  title: string;
  comments: Comment[];
  children: ReactNode;
}) {
  return (
    <section className="bg-surface-secondary rounded-lg border border-white/[0.06] p-3.5 space-y-2">
      <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">{title}</h4>
      {children}
      <BlockGrain artifactId={artifactId} sectionId={sectionId} label={title} comments={comments} />
    </section>
  );
}

export function ExplainerArtifact({ artifact }: ExplainerArtifactProps) {
  // Coercion boundary — turn raw/partial/legacy content into a fully-shaped
  // ExplainerContent so the renderer can trust the shape (mirrors how
  // ResearchArtifact / DebriefArtifact memoize their coercers at the source).
  const content = useMemo<ExplainerContent>(
    () => coerceExplainerContent(artifact.content),
    [artifact.content],
  );
  const comments = useChainComments(artifact.id);

  const sections = content.sections ?? [];
  const relatedArtifactIds = content.relatedArtifactIds ?? [];
  const suggestedQuestions = content.suggestedQuestions ?? [];

  // #190 A2 — one-click question chips prefill the ask-anything composer. Bump a
  // nonce on each click so CommentThread's prefill effect fires per click.
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });

  // #193 E2 — "Ask more" (the acknowledge footer's secondary) jumps the reader
  // to the ask-anything composer. Bump this to focus it without touching the draft.
  const [askFocus, setAskFocus] = useState(0);

  return (
    <div className="space-y-4">
      {/* Overview — "what you're about to read", always present. */}
      <ExplainerBlock
        artifactId={artifact.id}
        sectionId="explainer:overview"
        title="What you're about to read"
        comments={comments}
      >
        {content.title && (
          <div className="text-sm font-semibold text-text-primary">{content.title}</div>
        )}
        <SimpleMarkdown text={content.overview} className="text-sm text-text-secondary space-y-2" />
      </ExplainerBlock>

      {/* The ordered walk-through — numbered progression, read top to bottom. */}
      {sections.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
            The walk-through ({sections.length})
          </h4>
          {sections.map((section, i) => {
            const sectionId = `explainer:${i}`;
            const grain = comments.filter((c) => c.target.sectionId === sectionId);
            return (
              <section
                key={i}
                data-comment-anchor={sectionId}
                data-testid="explainer-section"
                className="bg-surface-secondary rounded-lg border border-white/[0.06] p-3.5 space-y-2"
              >
                <div className="flex items-start gap-2">
                  {/* The numbered progression marker. */}
                  <span
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full
                               bg-accent-blue-dim/40 text-accent-blue text-2xs font-bold"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="text-sm font-semibold text-text-primary">{section.heading}</div>
                    {section.body && (
                      <SimpleMarkdown text={section.body} className="text-xs text-text-secondary space-y-1" />
                    )}

                    {/* Evidence — reuse the Research renderer (Evidence +
                        CommentableCode). The section index doubles as findingIndex:
                        an explainer has no findings, so the namespace is its own. */}
                    {section.evidence != null &&
                      renderEvidence(section.evidence, artifact.id, i, comments)}

                    <BlockGrain
                      artifactId={artifact.id}
                      sectionId={sectionId}
                      label={section.heading || `section ${i + 1}`}
                      comments={grain}
                    />
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Related artifacts to drill into. */}
      {relatedArtifactIds.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap" data-testid="explainer-related">
          <span className="text-2xs text-text-muted">Related:</span>
          {relatedArtifactIds.map((ref) => (
            <ArtifactRefLink key={ref} id={ref} />
          ))}
        </div>
      )}

      {/* Ask-anything thread — questions post with intent:"question" (the
          question-priority lane) via CommentThread's secondary submit. The
          suggestedQuestions render as one-click chips that prefill the composer.
          #193 E2 — this IS the artifact-level comment surface for the explainer:
          ArtifactPanel folds its separate "Comments" thread away for this type,
          so the reader has ONE conversational composer, not two. */}
      <div className="pt-3 border-t-2 border-accent-blue/20 space-y-2" data-testid="explainer-ask-anything">
        <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
          Ask me anything
        </h4>
        <p className="text-2xs text-text-muted">
          Anything unclear about how this works? Ask — I'll answer on my next turn.
        </p>

        {suggestedQuestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="explainer-suggested-questions">
            {suggestedQuestions.map((q, i) => (
              <button
                key={i}
                type="button"
                data-testid="explainer-question-chip"
                onClick={() => setPrefill({ text: q, nonce: prefill.nonce + 1 })}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-border-subtle
                           bg-surface-elevated text-2xs text-text-secondary hover:border-accent-blue
                           hover:text-accent-blue transition-colors press-scale text-left"
                title="Click to ask this — it fills the box below"
              >
                <span aria-hidden="true">💬</span>
                {q}
              </button>
            ))}
          </div>
        )}

        <CommentThread
          artifactId={artifact.id}
          comments={comments.filter(
            (c) =>
              c.target.sectionId == null &&
              c.target.lineStart == null &&
              c.target.findingIndex == null,
          )}
          target={{ artifactId: artifact.id }}
          placeholder="Comment on this walk-through, or ask a question…"
          submitLabel="Comment"
          textareaLabel="Comment on this explainer"
          secondarySubmitLabel="Ask"
          secondarySubmitTitle="Ask the agent a question about this explainer"
          prefill={prefill.nonce > 0 ? prefill : undefined}
          focusSignal={askFocus > 0 ? askFocus : undefined}
          roomy
        />
      </div>

      {/* #193 E2 — the explainer is a read-only TEACHING artifact: no approach is
          being proposed, so there's nothing to approve/reject/request-changes.
          The footer is an ACKNOWLEDGE bar — "Got it" (marks it read; hands the
          turn back) + "Ask more" (jumps to the composer above). It STAYS a
          "waiting on you" item until acknowledged — reading it IS your turn. */}
      <ArtifactStatusActions
        artifact={artifact}
        acknowledgeMode
        onAskMore={() => setAskFocus((n) => n + 1)}
      />
    </div>
  );
}
