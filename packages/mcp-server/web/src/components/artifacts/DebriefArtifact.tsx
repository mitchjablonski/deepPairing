import { useMemo, useState, type ReactNode } from "react";
import type { Artifact, Comment, DebriefContent } from "@deeppairing/shared";
import { coerceDebriefContent } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useChainComments } from "../../hooks/useChainComments";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { ConceptBadge } from "../ConceptBadge";
import { CommentThread } from "../CommentThread";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { renderEvidence } from "./ResearchArtifact";
import { OpenQuestionSection } from "./OpenQuestionSection";
import { useWriteLock } from "../../hooks/useWriteLock";
import { WalkMeThroughButton } from "../WalkMeThrough";

/**
 * #190 — the end-of-feature DEBRIEF renderer (the comprehension surface).
 *
 * A debrief is written in SECOND PERSON to your pair: here's what we built and
 * why, the calls I made without you (the accountability block), what I'd like
 * your eyes on, and what I left for later — with an ask-anything thread at the
 * bottom.
 *
 * Reuse, not rebuild:
 *   - concepts → ConceptBadge (the shared dense concept treatment DecisionCard +
 *     CodeChangeArtifact already use — the learning lever: name the pattern).
 *   - evidence → renderEvidence/EvidenceItem exported from ResearchArtifact (the
 *     exact Evidence + CommentableCode + FileViewer wiring).
 *   - the ask-anything + per-block grain composers → CommentThread (Comment +
 *     Ask intents), the same component the decision workbench threads.
 *   - the unified verb triad → ArtifactStatusActions (Approve / Request changes
 *     / Reject), dropped in like every other renderer.
 *
 * Grain commenting: every block is commentable at a sectionId grain the server
 * delivery layer already parses — EXACTLY:
 *   - summary          → `debrief:summary`
 *   - ordered walk[i]  → `debrief:<i>`  (0-based)
 *   - decisionsMade    → `debrief:decisions`
 *   - needsYourEyes    → `debrief:needs-your-eyes`
 *   - deferred         → `debrief:deferred`
 */

interface DebriefArtifactProps {
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

/** A drill-in link to an underlying artifact (changeset / other). Clicking
 *  SELECTS that artifact in the panel. */
function ArtifactRefLink({ id, label }: { id: string; label?: string }) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const title = artifacts.find((a) => a.id === id)?.title;
  return (
    <button
      type="button"
      onClick={() => focusArtifact(id)}
      data-testid="debrief-artifact-ref"
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
 * A lightweight per-block grain-comment surface. Renders the block's existing
 * grain thread (if any) and a "💬 Comment" toggle that reveals a scoped
 * CommentThread posting to `{ artifactId, sectionId }`. Kept deliberately small
 * — the workbench's rail pattern, distilled to one block.
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
  /** #207 (I2) — on a retracted/terminal ("closed") or replayed ("frozen")
   *  debrief the grain composer is withheld: the "💬 Comment" toggle is pulled
   *  and, when a prior thread exists, its CommentThread renders read-only (posted
   *  history stays, composer gone). A comment here would otherwise reach the agent
   *  as actionable feedback on a debrief it already took back. */
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
            readOnly={readOnly}
          />
        </div>
      )}
    </div>
  );
}

/** A titled block wrapper: heading + content + its grain-comment surface. */
function DebriefBlock({
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
      <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">{title}</h4>
      {children}
      <BlockGrain artifactId={artifactId} sectionId={sectionId} label={title} comments={comments} readOnly={readOnly} />
    </section>
  );
}

export function DebriefArtifact({ artifact }: DebriefArtifactProps) {
  // Coercion boundary — turn raw/partial/legacy content into a fully-shaped
  // DebriefContent so the renderer can trust the shape (mirrors how
  // ResearchArtifact / ChangesetArtifact memoize their coercers at the source).
  const content = useMemo<DebriefContent>(
    () => coerceDebriefContent(artifact.content),
    [artifact.content],
  );
  const comments = useChainComments(artifact.id);
  // #207 (I2) — the WRITE AXIS, via the shared useWriteLock hook. A retracted
  // (→ "closed") or replayed (→ "frozen") debrief withholds EVERY composer it
  // hosts: per-item + per-block grain (BlockGrain), the walk's evidence gutters
  // (renderEvidence), the open questions, and the ask-anything thread. Draft
  // ("review") stays writable; approved ("follow_up") STAYS late-commentable (the
  // #187 lane). Posted history stays readable throughout.
  const writeLocked = useWriteLock(artifact.status);

  const sections = content.sections ?? [];
  const decisionsMade = content.decisionsMade ?? [];
  const needsYourEyes = content.needsYourEyes ?? [];
  const deferred = content.deferred ?? [];
  const openQuestions = content.openQuestions ?? [];

  // O2 (#230) — progressive disclosure. DebriefArtifact already front-loads
  // needs-your-eyes + summary (the 30-second view); the ordered "walk" used to
  // render fully expanded below them, forcing the skimmer to scroll past every
  // section. It now collapses behind a single disclosure so one artifact serves
  // both the skimmer and the deep-diver — needs-your-eyes + summary stay ALWAYS
  // visible above it. A section carrying a live grain thread defaults the walk
  // EXPANDED so an unresolved comment is never hidden; an explicit toggle still
  // wins either way (walkOpen === null means "use the thread-derived default").
  const walkHasThread = useMemo(
    () => sections.some((_, i) => comments.some((c) => c.target.sectionId === `debrief:${i}`)),
    [sections, comments],
  );
  const [walkOpen, setWalkOpen] = useState<boolean | null>(null);
  const walkExpanded = walkOpen ?? walkHasThread;

  return (
    <div className="space-y-4">
      {/* #193 E2 (usability M4) — "Needs your eyes" renders ABOVE the fold, before
          the narrative and the walk. "What do I actually have to look at?" must
          not require scrolling past everything the agent already handled. Each
          item carries its OWN per-item grain (`debrief:needs-your-eyes:<i>`) so a
          comment anchors to the specific flagged item, not the whole lane. */}
      {needsYourEyes.length > 0 && (
        <section
          data-comment-anchor="debrief:needs-your-eyes"
          className="bg-surface-secondary rounded-lg border border-accent-blue/25 p-3.5 space-y-2"
        >
          <h4 className="text-xs font-semibold text-accent-blue uppercase tracking-wide">Needs your eyes</h4>
          <ol className="space-y-2 list-none">
            {needsYourEyes.map((item, i) => (
              <li
                key={i}
                data-testid="debrief-needs-eyes"
                className="rounded-md border-l-2 border-accent-blue bg-accent-blue-dim/15 p-2.5 space-y-1"
              >
                <div className="flex items-start gap-2">
                  <span className="text-2xs font-bold text-accent-blue mt-0.5 shrink-0">{i + 1}</span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-xs font-medium text-text-primary">{item.what}</div>
                    <div className="text-2xs text-text-secondary">
                      <span className="text-text-muted">Why: </span>
                      {item.why}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {item.artifactRef && (
                        <ArtifactRefLink id={item.artifactRef} label="Open to review →" />
                      )}
                      {/* P2 fix 2 (round-11 MED) — the REF TRAVELS. O2 passed a
                          BOOLEAN `hasArtifactRef`, so the emitted text claimed
                          "scoped to the linked artifact" while the id itself never
                          left the browser. Pass the ref (plus the debrief and the
                          per-item anchor) and the button puts it in both the prose
                          and the structured scope. */}
                      <WalkMeThroughButton
                        target={{
                          kind: "needs-eyes",
                          what: item.what,
                          why: item.why,
                          artifactRef: item.artifactRef,
                          artifactId: artifact.id,
                          itemRef: `debrief:needs-your-eyes:${i}`,
                        }}
                      />
                    </div>
                    <BlockGrain
                      artifactId={artifact.id}
                      sectionId={`debrief:needs-your-eyes:${i}`}
                      label={item.what || `needs-your-eyes item ${i + 1}`}
                      comments={comments}
                      readOnly={writeLocked}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Summary — the narrative headline, always present. */}
      <DebriefBlock
        artifactId={artifact.id}
        sectionId="debrief:summary"
        title="What we built"
        comments={comments}
        readOnly={writeLocked}
      >
        <SimpleMarkdown text={content.summary} className="text-sm text-text-secondary space-y-2" />
      </DebriefBlock>

      {/* The ordered walk of what changed — collapsed behind a disclosure (O2).
          Skimmers keep needs-your-eyes + summary above; deep readers are one
          click away. Auto-expanded when a section holds a live comment thread. */}
      {/* P2 fix 5 (round-11 MED) — the disclosure toggle below used to be
          BYTE-IDENTICAL to the static section headings ("WHAT WE BUILT"): same
          size, weight, muted color, uppercase, default cursor — so a skimmer read
          "FULL WALK-THROUGH (3 SECTIONS)" as an empty section and never clicked
          it. It now reads as a CONTROL: bordered pill on the surface, a chevron
          that rotates, hover background, sentence case (no heading mimicry),
          pointer cursor. */}
      {sections.length > 0 && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setWalkOpen((v) => !(v ?? walkHasThread))}
            aria-expanded={walkExpanded}
            data-testid="debrief-walk-toggle"
            className="group inline-flex items-center gap-1.5 cursor-pointer rounded-md border border-border-default
                       bg-surface-elevated px-2.5 py-1 text-xs font-medium text-text-secondary
                       hover:bg-surface-hover hover:text-accent-blue hover:border-accent-blue/50
                       focus-visible:text-accent-blue focus-visible:outline-none
                       focus-visible:ring-1 focus-visible:ring-accent-blue transition-colors"
          >
            <span
              aria-hidden="true"
              className={`text-text-muted transition-transform group-hover:text-accent-blue ${walkExpanded ? "rotate-90" : ""}`}
            >
              ▸
            </span>
            <span>
              {walkExpanded ? "Hide the walk" : "Show the full walk-through"} ({sections.length} section{sections.length === 1 ? "" : "s"})
            </span>
            {!walkExpanded && walkHasThread && (
              <span className="text-2xs text-accent-blue font-medium">· has your comments</span>
            )}
          </button>
          {walkExpanded && sections.map((section, i) => {
            const sectionId = `debrief:${i}`;
            const grain = comments.filter((c) => c.target.sectionId === sectionId);
            return (
              <section
                key={i}
                data-comment-anchor={sectionId}
                className="bg-surface-secondary rounded-lg border border-white/[0.06] p-3.5 space-y-2"
              >
                <div className="text-sm font-semibold text-text-primary">{section.title}</div>
                {section.body && (
                  <SimpleMarkdown text={section.body} className="text-xs text-text-secondary space-y-1" />
                )}

                {/* Concepts — the learning lever (reuse ConceptBadge). */}
                {Array.isArray(section.concepts) && section.concepts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {section.concepts.map((c, ci) => (
                      <ConceptBadge key={ci} name={c.name} explanation={c.oneLineExplanation} size="md" />
                    ))}
                  </div>
                )}

                {/* Evidence — reuse the Research renderer (Evidence +
                    CommentableCode). The section index doubles as findingIndex:
                    a debrief has no findings, so the namespace is its own. */}
                {section.evidence != null &&
                  renderEvidence(section.evidence, artifact.id, i, comments, writeLocked)}

                {/* Drill-in links to the underlying artifacts. */}
                {(section.changesetRef || (section.artifactRefs && section.artifactRefs.length > 0)) && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    <span className="text-2xs text-text-muted">Drill in:</span>
                    {section.changesetRef && <ArtifactRefLink id={section.changesetRef} />}
                    {section.artifactRefs?.map((ref) => (
                      <ArtifactRefLink key={ref} id={ref} />
                    ))}
                  </div>
                )}

                <BlockGrain
                  artifactId={artifact.id}
                  sectionId={sectionId}
                  label={section.title || `section ${i + 1}`}
                  comments={grain}
                  readOnly={writeLocked}
                />
              </section>
            );
          })}
        </div>
      )}

      {/* Decisions I made on my own — the accountability block, visually
          distinct (amber, the "look here" tone). #193 E2 — per-item grain
          (`debrief:decisions:<i>`) so pushback anchors to the specific call. */}
      {decisionsMade.length > 0 && (
        <section
          data-comment-anchor="debrief:decisions"
          className="bg-surface-secondary rounded-lg border border-white/[0.06] p-3.5 space-y-2"
        >
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Calls I made on my own</h4>
          <p className="text-2xs text-text-muted -mt-1">
            Decisions I took without checking with you first — push back if any of these are wrong.
          </p>
          <div className="space-y-2">
            {decisionsMade.map((d, i) => (
              <div
                key={i}
                data-testid="debrief-decision"
                className="rounded-md border-l-2 border-accent-amber bg-accent-amber-dim/20 p-2.5 space-y-1"
              >
                <div className="text-xs font-medium text-text-primary">{d.what}</div>
                <div className="text-2xs text-text-secondary">
                  <span className="text-text-muted">Why: </span>
                  {d.why}
                </div>
                {d.alternative && (
                  <div className="text-2xs text-text-secondary">
                    <span className="text-text-muted">Alternative I considered: </span>
                    {d.alternative}
                  </div>
                )}
                <BlockGrain
                  artifactId={artifact.id}
                  sectionId={`debrief:decisions:${i}`}
                  label={d.what || `decision ${i + 1}`}
                  comments={comments}
                  readOnly={writeLocked}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Deferred — what I left undone + why. #193 E2 — per-item grain
          (`debrief:deferred:<i>`) so a "actually, do this now" anchors to the
          specific item. */}
      {deferred.length > 0 && (
        <section
          data-comment-anchor="debrief:deferred"
          className="bg-surface-secondary rounded-lg border border-white/[0.06] p-3.5 space-y-2"
        >
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Left for later</h4>
          <ul className="space-y-2">
            {deferred.map((d, i) => (
              <li key={i} data-testid="debrief-deferred" className="text-xs text-text-secondary space-y-1">
                <div className="flex items-start gap-2">
                  <span className="text-text-muted mt-0.5 shrink-0" aria-hidden="true">•</span>
                  <span>
                    <span className="font-medium text-text-primary">{d.what}</span>
                    <span className="text-text-muted"> — {d.why}</span>
                  </span>
                </div>
                <div className="pl-4">
                  <BlockGrain
                    artifactId={artifact.id}
                    sectionId={`debrief:deferred:${i}`}
                    label={d.what || `deferred item ${i + 1}`}
                    comments={comments}
                    readOnly={writeLocked}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Open questions — MY questions for YOU. Reuse the shared
          OpenQuestionSection (spec/plan/research host it identically), so each
          answer rides the questionIndex comment lane the server delivery already
          resolves against content.openQuestions. */}
      {openQuestions.length > 0 && (
        <div className="space-y-2" data-testid="debrief-open-questions">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
            Open questions ({openQuestions.length})
          </h4>
          <p className="text-2xs text-text-muted -mt-1">
            Things I'd like your call on — answer any inline.
          </p>
          <div className="space-y-1.5">
            {openQuestions.map((q, i) => (
              <OpenQuestionSection key={i} artifactId={artifact.id} question={q} index={i} readOnly={writeLocked} />
            ))}
          </div>
        </div>
      )}

      {/* Ask-anything thread — questions post with intent:"question" (the
          question-priority lane) via CommentThread's secondary submit.
          #193 E2 (M2) — this IS the debrief's artifact-level comment surface:
          ArtifactPanel folds its separate "Comments" thread away for this type,
          so there's ONE conversational composer. A heavier top border visually
          separates the conversation from the verdict bar below. */}
      <div className="pt-3 border-t-2 border-accent-violet/20 space-y-2" data-testid="debrief-ask-anything">
        <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
          Ask me anything
        </h4>
        <p className="text-2xs text-text-muted">
          {writeLocked
            ? "This debrief is read-only — the earlier conversation is preserved below."
            : "Anything unclear about what I did? Ask — I'll answer on my next turn."}
        </p>
        <CommentThread
          artifactId={artifact.id}
          comments={comments.filter(
            (c) =>
              c.target.sectionId == null &&
              c.target.lineStart == null &&
              c.target.findingIndex == null,
          )}
          target={{ artifactId: artifact.id }}
          placeholder="Comment on this debrief, or ask a question…"
          submitLabel="Comment"
          textareaLabel="Comment on this debrief"
          secondarySubmitLabel="Ask"
          secondarySubmitTitle="Ask the agent a question about this debrief"
          readOnly={writeLocked}
          roomy
        />
      </div>

      {/* Verdict bar — Approve / Request changes / Reject. #193 E2 (coverage M2)
          — a rejected debrief means "redo this digest", NOT "never do it this
          way again": it's an account of finished work, not a proposed approach.
          So `suppressRejectConcept` de-fangs Reject — no "name the pattern"
          cross-project ledger capture (the server guards this authoritatively
          too). Approve / Request-changes stay fully meaningful. */}
      <ArtifactStatusActions artifact={artifact} suppressRejectConcept />
    </div>
  );
}
