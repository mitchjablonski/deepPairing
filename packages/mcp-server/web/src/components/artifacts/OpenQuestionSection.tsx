import { useId } from "react";
import { useArtifactStore } from "../../stores/artifact";
import { useChainComments } from "../../hooks/useChainComments";
import { CommentThread } from "../CommentThread";

/**
 * #164 — one open question, rendered as its own bounded section.
 *
 * The original design cramped each question into a list ROW: text on the left,
 * tiny Ask/Comment icon-triggers squeezed on the right, and the reply thread
 * hidden inside a popover — so "just comment below" always won and answering
 * the specific question felt like an afterthought.
 *
 * Round 2 (field verdict): no disclosure click either. The answer composer is
 * simply THERE — the human types once and chooses at submit: **Answer** posts
 * a plain comment; **Ask** posts with intent:"question" (the AskTrigger
 * path's semantics — check_feedback's question-priority lane). The
 * conversation about THIS question (filtered by questionIndex) is threaded
 * inline above the composer, so answers live with the question.
 *
 * Shared by ResearchArtifact and SpecArtifact — the two were near-duplicate
 * row renderers; one component keeps them consistent by construction.
 */
export function OpenQuestionSection({
  artifactId,
  question,
  index,
}: {
  artifactId: string;
  question: string;
  index: number;
}) {
  const comments = useChainComments(artifactId); // Bug2 — chain aggregation
  const markQuestionResolved = useArtifactStore((s) => s.markQuestionResolved);

  // The whole conversation pinned to THIS question (the human's answers/asks
  // and the agent's replies), threaded inline beneath it.
  const questionComments = comments.filter((c) => c.target.questionIndex === index);

  // D8 review (carried verbatim from the old row) — the human's OWN unanswered
  // AskTrigger question must NOT stamp the section "answered"; only plain
  // comments / answered questions count as an answer.
  const answers = questionComments.filter(
    (c) => !(c.intent === "question" && !c.answeredByCommentId),
  );
  const answered = answers.length > 0;

  // Carried over from the retired AskTrigger popover (its one non-submit
  // affordance): the human can mark their own unanswered ask resolved, so it
  // stops counting as waiting-on-the-agent. The thread bubble already shows
  // the "delivered · awaiting agent" state; this is the way out of it.
  const ownUnresolvedAsks = questionComments.filter(
    (c) =>
      c.author === "human" &&
      c.intent === "question" &&
      !c.answeredByCommentId &&
      !c.humanResolvedAt,
  );

  const labelId = useId();

  // Preserve the exact targeting the old row used on both trigger paths.
  const target = { questionIndex: index, sectionId: "open-question" as const };

  return (
    <section
      aria-labelledby={labelId}
      className="bg-surface-secondary rounded-lg border border-white/[0.06] p-3.5 space-y-3"
    >
      {/* Question — the section's label. Not a heading (keeps axe heading-order
          clean across both artifacts, which nest these differently); the
          section is named by it via aria-labelledby. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Full-strength accent-amber — the /80 blend measured 3.94:1 on the
              light theme's surface-secondary (axe, real scan); full token
              passes AA on both themes. */}
          <div className="text-[9px] font-semibold uppercase tracking-wide text-accent-amber mb-1">
            Question {index + 1}
          </div>
          <p
            id={labelId}
            className="text-sm font-medium text-text-primary leading-snug"
          >
            {question}
          </p>
        </div>
        {answered && (
          <span
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-accent-green-dim text-accent-green"
            title="This question has an answer"
          >
            <span aria-hidden>✓</span> answered
          </span>
        )}
      </div>

      {/* The escape hatch for an ask the agent never answered (e.g. the
          session ended) — without it the question waits forever. */}
      {ownUnresolvedAsks.map((q) => (
        <div key={q.id} className="flex items-center gap-2 text-2xs text-text-muted">
          <span className="italic">You asked the agent — awaiting its next turn.</span>
          <button
            type="button"
            onClick={() => void markQuestionResolved(q.id).catch(() => {})}
            title="Mark this question resolved — stops it counting as waiting on the agent"
            className="text-accent-blue hover:underline"
          >
            Mark resolved
          </button>
        </div>
      ))}

      {/* Inline thread + always-visible composer. Reuses CommentThread (single
          source of threading + drafts + the ⌘⏎-answers shortcut), re-voiced as
          an answer box with a second, question-intent submit ("Ask"). */}
      <CommentThread
        artifactId={artifactId}
        comments={questionComments}
        target={target}
        placeholder="Answer this question… (⌘⏎ to send)"
        submitLabel="Answer"
        secondarySubmitLabel="Ask"
        secondarySubmitTitle="Ask the agent about this question — it will answer on its next turn"
        textareaLabel={`Answer question ${index + 1}`}
      />
    </section>
  );
}
