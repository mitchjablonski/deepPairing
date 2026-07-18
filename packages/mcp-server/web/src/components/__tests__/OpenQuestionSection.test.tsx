import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useArtifactStore } from "../../stores/artifact";
import { ResearchArtifact } from "../artifacts/ResearchArtifact";
import { SpecArtifact } from "../artifacts/SpecArtifact";
import { ArtifactDetail } from "../ArtifactPanel";

/**
 * #164 — open-question redesign (round 2, field verdict). Each open question
 * renders as its own bounded <section> (the shared OpenQuestionSection) with
 * an ALWAYS-VISIBLE answer composer (no disclosure click) carrying two submit
 * buttons — Answer (plain comment) and Ask (question-intent) — and the reply
 * thread inline above the composer. These pin the NEW structure, so they fail
 * against both the old list-row rendering and the round-1 disclosure design.
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

describe("#164 — open questions render as bounded sections with an always-visible composer", () => {
  beforeEach(() => {
    // restoreAllMocks BEFORE reset: the submitComment spy lives on the zustand
    // state object itself and survives reset()'s partial set — without this,
    // spyOn() in a later test returns the SAME spy with accumulated calls.
    vi.restoreAllMocks();
    useArtifactStore.getState().reset();
  });

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

  it("the composer is ALREADY there — labelled textarea + Answer/Ask buttons, no disclosure click", () => {
    const artifact = mk("research", {
      summary: "s",
      findings: [],
      openQuestions: ["Cache write-through?"],
    });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    render(<ResearchArtifact artifact={artifact} />);

    const section = sectionFor("Cache write-through?");
    // Composer visible with zero interaction (round-2 verdict: pre-existing
    // text box; the round-1 "Answer this question" disclosure is GONE).
    expect(within(section).getByLabelText("Answer question 1")).toBeInTheDocument();
    expect(
      within(section).queryByRole("button", { name: /answer this question/i }),
    ).not.toBeInTheDocument();

    // Both submit paths are real buttons, disabled while the input is empty.
    const answerBtn = within(section).getByRole("button", { name: "Answer" });
    const askBtn = within(section).getByRole("button", { name: "Ask" });
    expect(answerBtn.tagName).toBe("BUTTON");
    expect(askBtn.tagName).toBe("BUTTON");
    expect(answerBtn).toBeDisabled();
    expect(askBtn).toBeDisabled();
  });

  it("Answer posts a plain comment to the question's exact target (questionIndex 0 — falsy-zero safe)", async () => {
    const user = userEvent.setup();
    const artifact = mk("research", { summary: "s", findings: [], openQuestions: ["Which DB?"] });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    const spy = vi
      .spyOn(useArtifactStore.getState(), "submitComment")
      .mockResolvedValue(undefined);
    render(<ResearchArtifact artifact={artifact} />);

    const section = sectionFor("Which DB?");
    await user.type(within(section).getByLabelText("Answer question 1"), "Postgres");
    const answerBtn = within(section).getByRole("button", { name: "Answer" });
    expect(answerBtn).toBeEnabled();
    await user.click(answerBtn);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      artifact.id,
      "Postgres",
      expect.objectContaining({ questionIndex: 0, sectionId: "open-question" }),
      undefined, // plain comment — NO intent
    );
  });

  it("Ask posts with intent:'question' to the RIGHT questionIndex (question 2 → index 1)", async () => {
    const user = userEvent.setup();
    const artifact = mk("research", {
      summary: "s",
      findings: [],
      openQuestions: ["First question?", "Second question?"],
    });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    const spy = vi
      .spyOn(useArtifactStore.getState(), "submitComment")
      .mockResolvedValue(undefined);
    render(<ResearchArtifact artifact={artifact} />);

    const second = sectionFor("Second question?");
    await user.type(within(second).getByLabelText("Answer question 2"), "why is this open?");
    await user.click(within(second).getByRole("button", { name: "Ask" }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      artifact.id,
      "why is this open?",
      expect.objectContaining({ questionIndex: 1, sectionId: "open-question" }),
      { intent: "question" },
    );
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
    // ...and NOT under the first.
    const first = sectionFor("First question?");
    expect(within(first).queryByText("REPLY-TO-SECOND")).not.toBeInTheDocument();
  });

  it("replies render inline ABOVE the composer, visible with zero interaction", () => {
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
    const reply = within(section).getByText("Postgres, for the JSONB support.");
    expect(reply).toBeInTheDocument();
    // Thread ABOVE composer: the textarea comes after the reply in the DOM.
    const textarea = within(section).getByLabelText("Answer question 1");
    expect(
      reply.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

  it("D8: a human's OWN unanswered question does NOT stamp the section 'answered' (and offers Mark resolved)", () => {
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
    const section = sectionFor("Which DB?");
    // The ask renders in the thread but must not read as answered.
    expect(within(section).getByText("wait, what are the options?")).toBeInTheDocument();
    expect(within(section).queryByText(/✓ answered/i)).not.toBeInTheDocument();
    // Carried over from the retired AskTrigger popover: the human can mark
    // their own stranded ask resolved from the section.
    expect(within(section).getByRole("button", { name: /mark resolved/i })).toBeInTheDocument();
  });

  it("keyboard: type + Ctrl/Cmd+Enter submits as Answer (plain — no intent)", async () => {
    const user = userEvent.setup();
    const artifact = mk("research", { summary: "s", findings: [], openQuestions: ["Which DB?"] });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    const spy = vi
      .spyOn(useArtifactStore.getState(), "submitComment")
      .mockResolvedValue(undefined);
    render(<ResearchArtifact artifact={artifact} />);

    const textarea = within(sectionFor("Which DB?")).getByLabelText("Answer question 1");
    await user.type(textarea, "Postgres");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      artifact.id,
      "Postgres",
      expect.objectContaining({ questionIndex: 0, sectionId: "open-question" }),
      undefined, // the shortcut is the ANSWER path, never the ask path
    );
  });

  it("REGRESSION: a question-targeted answer renders exactly ONCE on the full artifact page (not again in the bottom Comments thread)", async () => {
    // Pre-fix, ArtifactDetail's generalComments filter didn't exclude
    // questionIndex-targeted comments, so an answer showed TWICE: inline in
    // its OpenQuestionSection AND in the artifact's bottom "Comments" thread
    // (getAllByText length was 2). questionIndex 0 on purpose — the filter
    // must be `== null`, not falsy, or the FIRST question regresses.
    const artifact = mk("research", { summary: "s", findings: [], openQuestions: ["Which DB?"] });
    useArtifactStore.setState({
      artifacts: [artifact],
      comments: {
        [artifact.id]: [
          comment({
            artifactId: artifact.id,
            content: "UNIQUE-ANSWER-BODY",
            target: { artifactId: artifact.id, questionIndex: 0, sectionId: "open-question" },
          }),
        ],
      },
    });
    render(<ArtifactDetail artifact={artifact} />);
    // The research renderer is a lazy chunk under Suspense — await its mount.
    await screen.findByText("Which DB?");
    expect(screen.getAllByText("UNIQUE-ANSWER-BODY")).toHaveLength(1);
    // And the one copy is the inline one, inside the question's section.
    expect(within(sectionFor("Which DB?")).getByText("UNIQUE-ANSWER-BODY")).toBeInTheDocument();
  });
});
