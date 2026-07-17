import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { useArtifactStore } from "../../stores/artifact";
import { ResearchArtifact } from "../artifacts/ResearchArtifact";
import { SpecArtifact } from "../artifacts/SpecArtifact";

/**
 * #164 — open-question redesign. Each open question renders as its own bounded
 * <section> (the shared OpenQuestionSection) with a prominent answer button and
 * the reply thread inline — replacing the cramped list ROW with tiny icon
 * triggers and a popover-only thread. These pin the NEW structure, so they fail
 * against the old list-row rendering.
 */

const mk = (type: string, content: any, over: any = {}) =>
  ({
    id: over.id ?? "art1",
    type,
    title: "t",
    status: "draft",
    version: 1,
    createdAt: "2026-06-01T00:00:00.000Z",
    content,
    ...over,
  }) as any;

const comment = (over: Partial<any> & { artifactId: string; target: any }) =>
  ({
    id: over.id ?? `c_${Math.random().toString(36).slice(2)}`,
    author: over.author ?? "human",
    content: over.content ?? "a reply",
    createdAt: over.createdAt ?? new Date().toISOString(),
    parentCommentId: null,
    ...over,
  }) as any;

/** The section that carries a given question, via aria-labelledby → the
 *  question <p> the section is named by. Proves per-question bounding. */
function sectionFor(questionText: string): HTMLElement {
  const label = screen.getByText(questionText);
  const section = label.closest("section");
  if (!section) throw new Error(`no <section> wraps question "${questionText}"`);
  return section as HTMLElement;
}

describe("#164 — open questions render as bounded sections", () => {
  beforeEach(() => useArtifactStore.getState().reset());

  it("research: one <section> per question, each named by its question text", () => {
    const artifact = mk("research", {
      summary: "s",
      findings: [],
      openQuestions: ["Cache write-through?", "Which eviction policy?", "TTL default?"],
    });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    render(<ResearchArtifact artifact={artifact} />);

    // Header advertises the count; three distinct sections exist.
    expect(screen.getByText("Open Questions (3)")).toBeInTheDocument();
    for (const q of ["Cache write-through?", "Which eviction policy?", "TTL default?"]) {
      const section = sectionFor(q);
      // The section is LABELLED by the question (a11y: clearly labeled).
      const labelId = section.getAttribute("aria-labelledby");
      expect(labelId).toBeTruthy();
      expect(within(section).getByText(q).id).toBe(labelId);
    }
  });

  it("spec: one <section> per question (shared component — spec parity)", () => {
    const artifact = mk("spec", {
      objective: "obj",
      requirements: [],
      openQuestions: ["Auth optional?", "Which DB?"],
    });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    render(<SpecArtifact artifact={artifact} />);

    expect(screen.getByText("Open questions (2)")).toBeInTheDocument();
    expect(sectionFor("Auth optional?")).toBeInTheDocument();
    expect(sectionFor("Which DB?")).toBeInTheDocument();
  });

  it("the answer affordance is a REAL button with an accessible name (not a cramped icon)", () => {
    const artifact = mk("research", {
      summary: "s",
      findings: [],
      openQuestions: ["Cache write-through?"],
    });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    render(<ResearchArtifact artifact={artifact} />);

    const section = sectionFor("Cache write-through?");
    const answerBtn = within(section).getByRole("button", { name: /answer this question/i });
    expect(answerBtn.tagName).toBe("BUTTON");
    // Collapsed by default (no activity) → composer hidden behind the button.
    expect(answerBtn).toHaveAttribute("aria-expanded", "false");
  });

  it("questionIndex targeting: a reply on question 2 threads under question 2, NOT question 1", () => {
    const artifact = mk("research", {
      summary: "s",
      findings: [],
      openQuestions: ["First question?", "Second question?"],
    });
    useArtifactStore.setState({
      artifacts: [artifact],
      comments: {
        [artifact.id]: [
          comment({
            artifactId: artifact.id,
            content: "REPLY-TO-SECOND",
            target: { artifactId: artifact.id, questionIndex: 1, sectionId: "open-question" },
          }),
        ],
      },
    });
    render(<ResearchArtifact artifact={artifact} />);

    // The reply lives inline under the SECOND question's section...
    const second = sectionFor("Second question?");
    expect(within(second).getByText("REPLY-TO-SECOND")).toBeInTheDocument();
    // ...and NOT under the first (which stays collapsed with no thread).
    const first = sectionFor("First question?");
    expect(within(first).queryByText("REPLY-TO-SECOND")).not.toBeInTheDocument();
  });

  it("replies render inline beneath the question (section auto-expands when a thread exists)", () => {
    const artifact = mk("spec", {
      objective: "obj",
      requirements: [],
      openQuestions: ["Which DB?"],
    });
    useArtifactStore.setState({
      artifacts: [artifact],
      comments: {
        [artifact.id]: [
          comment({
            artifactId: artifact.id,
            content: "Postgres, for the JSONB support.",
            target: { artifactId: artifact.id, questionIndex: 0, sectionId: "open-question" },
          }),
        ],
      },
    });
    render(<SpecArtifact artifact={artifact} />);

    const section = sectionFor("Which DB?");
    expect(within(section).getByText("Postgres, for the JSONB support.")).toBeInTheDocument();
  });

  it("✓ answered shows when a plain comment answers the question", () => {
    const artifact = mk("research", { summary: "s", findings: [], openQuestions: ["Which DB?"] });
    useArtifactStore.setState({
      artifacts: [artifact],
      comments: {
        [artifact.id]: [
          comment({
            artifactId: artifact.id,
            content: "Postgres",
            target: { artifactId: artifact.id, questionIndex: 0, sectionId: "open-question" },
          }),
        ],
      },
    });
    render(<ResearchArtifact artifact={artifact} />);
    expect(within(sectionFor("Which DB?")).getByText(/answered/i)).toBeInTheDocument();
  });

  it("D8: a human's OWN unanswered question does NOT stamp the section 'answered'", () => {
    const artifact = mk("research", { summary: "s", findings: [], openQuestions: ["Which DB?"] });
    useArtifactStore.setState({
      artifacts: [artifact],
      comments: {
        [artifact.id]: [
          comment({
            artifactId: artifact.id,
            author: "human",
            intent: "question",
            answeredByCommentId: null,
            content: "wait, what are the options?",
            target: { artifactId: artifact.id, questionIndex: 0, sectionId: "open-question" },
          }),
        ],
      },
    });
    render(<ResearchArtifact artifact={artifact} />);
    // The question exists as a comment (so the section auto-expands), but it is
    // an unanswered ask BY the human — it must not read as answered.
    const section = sectionFor("Which DB?");
    expect(within(section).queryByText(/answered/i)).not.toBeInTheDocument();
  });

  it("the answer disclosure toggles the inline composer open (keyboard-operable button)", () => {
    const artifact = mk("research", { summary: "s", findings: [], openQuestions: ["Cache write-through?"] });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    render(<ResearchArtifact artifact={artifact} />);

    const section = sectionFor("Cache write-through?");
    const btn = within(section).getByRole("button", { name: /answer this question/i });
    // No composer yet.
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(btn);
    // Composer (the answer box) is now inline in the section.
    expect(within(section).getByLabelText(/answer question 1/i)).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: /^answer$/i })).toBeInTheDocument();
  });
});
