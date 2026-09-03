import { useMemo, useState, type ReactNode } from "react";
import type { Artifact, Comment, ExplainerContent } from "@deeppairing/shared";
import { coerceExplainerContent } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useChainComments } from "../../hooks/useChainComments";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { CommentThread } from "../CommentThread";
import { ArtifactVisuals } from "../ArtifactVisuals";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { renderEvidence } from "./ResearchArtifact";
import { useWriteLock } from "../../hooks/useWriteLock";
import { SpeechIcon } from "../icons/ArtifactIcons";

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
  readOnly = false,
}: {
  artifactId: string;
  sectionId: string;
  label: string;
  comments: Comment[];
  /** #207 (I2 review) — on a retracted/terminal ("closed") or replayed
   *  ("frozen") explainer the grain composer is withheld: the "💬 Comment"
   *  toggle is pulled and any prior thread renders read-only. */
  readOnly?: boolean;
}) {
  const grain = useMemo(
    () => comments.filter((c) => c.target.sectionId === sectionId),
    [comments, sectionId],
  );
  const [open, setOpen] = useState(false);
  // When read-only the "+ Comment" toggle never appears, so only reveal an
  // existing thread (read-only); an empty block renders nothing at all.
  const show = readOnly ? grain.length > 0 : open || grain.length > 0;

  return (
    <div className="mt-2">
      {!show && !readOnly && (
        <button
          type="button"
          data-grain-affordance
          onClick={() => setOpen(true)}
          aria-label={`Comment on ${label}`}
          className="inline-flex items-center gap-1 text-2xs text-text-muted hover:text-accent-blue transition-colors press-scale"
        >
          <span aria-hidden="true" className="inline-flex items-center"><SpeechIcon className="w-3 h-3" /></span> Comment
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
            readOnly={readOnly}
            // When the reader reveals this block's composer via "+ Comment"
            // (`open`), drop the caret in it. `open` is false on load — a block
            // shown only because a prior thread exists never grabs focus.
            focusOnOpen={open}
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
  readOnly = false,
}: {
  artifactId: string;
  sectionId: string;
  title: string;
  comments: Comment[];
  children: ReactNode;
  readOnly?: boolean;
}) {
  return (
    <section className="bg-surface-secondary rounded-lg border border-white/[0.06] p-3.5 space-y-2">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">{title}</h3>
      {children}
      <BlockGrain artifactId={artifactId} sectionId={sectionId} label={title} comments={comments} readOnly={readOnly} />
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
  // #207 (I2 review) — the WRITE AXIS, via the shared useWriteLock hook. A
  // retracted (→ "closed") or replayed (→ "frozen") explainer withholds every
  // composer (overview + walk grain, evidence gutters, ask-anything). An
  // ACKNOWLEDGED explainer is status "approved" → "follow_up": it STAYS late-
  // commentable (you can keep asking about code you've read), so approved is NOT
  // locked. Posted history stays readable.
  const writeLocked = useWriteLock(artifact.status);

  const sections = content.sections ?? [];
  const relatedArtifactIds = content.relatedArtifactIds ?? [];
  const suggestedQuestions = content.suggestedQuestions ?? [];
  const unknowns = content.unknowns ?? [];

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
        readOnly={writeLocked}
      >
        {content.title && (
          <div className="text-sm font-semibold text-text-primary">{content.title}</div>
        )}
        <SimpleMarkdown text={content.overview} className="prose-field text-sm text-text-secondary space-y-2" />
      </ExplainerBlock>

      {/* R4 P-C (#284) — WHAT I'M NOT SURE ABOUT, above the fold. The orientation
          artifact can now admit uncertainty — "I couldn't tell whether the CLI
          door is covered; I didn't read cli/init.ts" is the sentence a reviewer
          needs most. Each gap carries a one-click Ask that prefills + focuses the
          ask-anything composer below (the CTA — no CTA = graveyard). Withheld on
          a read-only explainer (nothing to ask an artifact you took back). */}
      {unknowns.length > 0 && (
        <section
          data-testid="explainer-unknowns"
          data-comment-anchor="explainer:unknowns"
          className="bg-surface-secondary rounded-lg border border-accent-amber/25 p-3.5 space-y-2"
        >
          <h3 className="text-xs font-semibold text-accent-amber uppercase tracking-wide">
            What I'm not sure about ({unknowns.length})
          </h3>
          <ul className="space-y-1.5">
            {unknowns.map((u, i) => (
              <li
                key={i}
                data-testid="explainer-unknown"
                className="flex items-start gap-2 rounded-md border-l-2 border-accent-amber bg-accent-amber-dim/15 p-2.5"
              >
                <span aria-hidden="true" className="text-accent-amber mt-0.5 shrink-0 text-2xs font-bold">?</span>
                <span className="min-w-0 flex-1 text-xs text-text-secondary">{u}</span>
                {!writeLocked && (
                  <button
                    type="button"
                    data-testid="explainer-unknown-ask"
                    onClick={() => {
                      setPrefill({ text: `About "${u}" — `, nonce: prefill.nonce + 1 });
                      setAskFocus((n) => n + 1);
                    }}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-border-subtle
                               bg-surface-elevated text-2xs text-text-secondary hover:border-accent-blue
                               hover:text-accent-blue transition-colors press-scale"
                    title="Ask the agent about this — fills the box below"
                  >
                    <span aria-hidden="true" className="inline-flex items-center"><SpeechIcon className="w-3 h-3" /></span>
                    Ask
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* R4 P-B (#284) — the walk-through's visuals (e.g. a sequence diagram of
          the request path being narrated). THE round-13 headline: before R4 an
          explainer passing visuals had them silently stripped at parse, so "draw
          me the shape" was impossible on the one surface built to transfer the
          world model. Self-hides when absent; carries region-comments. */}
      <ArtifactVisuals artifactId={artifact.id} visuals={content.visuals ?? []} readOnly={writeLocked} />

      {/* The ordered walk-through — numbered progression, read top to bottom. */}
      {sections.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
            The walk-through ({sections.length})
          </h3>
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
                      <SimpleMarkdown text={section.body} className="prose-field text-xs text-text-secondary space-y-1" />
                    )}

                    {/* Evidence — reuse the Research renderer (Evidence +
                        CommentableCode). The section index doubles as findingIndex:
                        an explainer has no findings, so the namespace is its own. */}
                    {section.evidence != null &&
                      renderEvidence(section.evidence, artifact.id, i, comments, writeLocked)}

                    <BlockGrain
                      artifactId={artifact.id}
                      sectionId={sectionId}
                      label={section.heading || `section ${i + 1}`}
                      comments={grain}
                      readOnly={writeLocked}
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
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
          Ask me anything
        </h3>
        <p className="text-2xs text-text-muted">
          {writeLocked
            ? "This explainer is read-only — the earlier conversation is preserved below."
            : "Anything unclear about how this works? Ask — I'll answer on my next turn."}
        </p>

        {!writeLocked && suggestedQuestions.length > 0 && (
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
                <span aria-hidden="true" className="inline-flex items-center"><SpeechIcon className="w-3 h-3" /></span>
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
          readOnly={writeLocked}
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
