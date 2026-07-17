import { useId, useState } from "react";
import { useChainComments } from "../../hooks/useChainComments";
import { AskTrigger, CommentThread } from "../CommentThread";

/**
 * #164 — one open question, rendered as its own bounded section.
 *
 * The old design cramped each question into a list ROW: text on the left,
 * tiny Ask/Comment icon-triggers squeezed on the right, and the reply thread
 * hidden inside a popover — so "just comment below" always won and answering
 * the specific question felt like an afterthought.
 *
 * This gives every question room: the question text as the section's label, a
 * prominent "Answer" affordance directly beneath it, and the conversation
 * about THIS question (filtered by questionIndex) threaded inline so the
 * answers live with the question. The Ask-the-agent (question-intent) path is
 * kept as a secondary pill.
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

  // The whole conversation pinned to THIS question (both the human's answers
  // and the agent's replies), threaded inline beneath it.
  const questionComments = comments.filter((c) => c.target.questionIndex === index);

  // D8 review (carried verbatim from the old row) — the human's OWN unanswered
  // AskTrigger question must NOT stamp the section "answered"; only plain
  // comments / answered questions count as an answer.
  const answers = questionComments.filter(
    (c) => !(c.intent === "question" && !c.answeredByCommentId),
  );
  const answered = answers.length > 0;

  // The conversation is shown inline whenever it exists (answering lives with
  // the question); an untouched question stays collapsed behind a prominent
  // Answer button so a wall of questions doesn't open a wall of composers.
  const [open, setOpen] = useState(questionComments.length > 0);

  const labelId = useId();
  const panelId = useId();

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
          <div className="text-[9px] font-semibold uppercase tracking-wide text-accent-amber/80 mb-1">
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

      {/* Primary + secondary affordances directly beneath the question. */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={panelId}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-2xs font-semibold press-scale transition-colors ${
            open
              ? "bg-surface-elevated text-text-secondary hover:bg-surface-hover"
              : "bg-accent-blue-strong text-white hover:bg-accent-blue/80"
          }`}
        >
          <span aria-hidden>{open ? "▾" : "✎"}</span>
          {open ? "Hide answer" : answered ? "Answer / discuss" : "Answer this question"}
        </button>
        <AskTrigger artifactId={artifactId} target={target} variant="pill" />
      </div>

      {/* Inline thread + answer composer — the conversation about this question,
          in place. Reuses CommentThread (single source of threading + the
          composer), re-voiced as an answer box. */}
      {open && (
        <div id={panelId} className="dp-fade-in pt-1">
          <CommentThread
            artifactId={artifactId}
            comments={questionComments}
            target={target}
            placeholder="Answer this question… (⌘⏎ to send)"
            submitLabel="Answer"
            textareaLabel={`Answer question ${index + 1}`}
          />
        </div>
      )}
    </section>
  );
}
