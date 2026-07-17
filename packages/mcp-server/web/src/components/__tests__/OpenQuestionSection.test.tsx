import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useArtifactStore } from "../../stores/artifact";
import { ResearchArtifact } from "../artifacts/ResearchArtifact";
import { SpecArtifact } from "../artifacts/SpecArtifact";
import { ArtifactDetail } from "../ArtifactPanel";

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

  it("the answer disclosure is keyboard-operable: Enter opens, Space toggles (real key events)", async () => {
    const user = userEvent.setup();
    const artifact = mk("research", { summary: "s", findings: [], openQuestions: ["Cache write-through?"] });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    render(<ResearchArtifact artifact={artifact} />);

    const section = sectionFor("Cache write-through?");
    const btn = within(section).getByRole("button", { name: /answer this question/i });
    // No composer yet.
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();

    // Enter on the focused button opens the composer (the answer box).
    act(() => btn.focus());
    await user.keyboard("{Enter}");
    expect(within(section).getByLabelText(/answer question 1/i)).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: /^answer$/i })).toBeInTheDocument();

    // Space toggles it closed again (focus is still on the disclosure button).
    await user.keyboard(" ");
    expect(within(section).queryByLabelText(/answer question 1/i)).not.toBeInTheDocument();
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

  it("a section that gains its FIRST comment while mounted expands live (WS reply), but a human-collapsed section stays collapsed on later replies", async () => {
    const user = userEvent.setup();
    const artifact = mk("research", { summary: "s", findings: [], openQuestions: ["Which DB?"] });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    render(<ResearchArtifact artifact={artifact} />);

    const section = sectionFor("Which DB?");
    // Mounted with no thread → collapsed.
    expect(within(section).queryByText("FIRST-REPLY")).not.toBeInTheDocument();

    // First comment arrives while mounted (e.g. agent reply over WS) → the
    // thread reveals itself (pre-fix: only the ✓ updated; the thread hid).
    act(() => {
      useArtifactStore.setState({
        comments: {
          [artifact.id]: [
            comment({
              id: "c_live1",
              artifactId: artifact.id,
              author: "agent",
              content: "FIRST-REPLY",
              target: { artifactId: artifact.id, questionIndex: 0, sectionId: "open-question" },
            }),
          ],
        },
      });
    });
    expect(within(section).getByText("FIRST-REPLY")).toBeInTheDocument();

    // The human deliberately collapses it…
    await user.click(within(section).getByRole("button", { name: /hide answer/i }));
    expect(within(section).queryByText("FIRST-REPLY")).not.toBeInTheDocument();

    // …a LATER reply (1→2) must not fight them and force it back open.
    act(() => {
      useArtifactStore.setState({
        comments: {
          [artifact.id]: [
            comment({
              id: "c_live1",
              artifactId: artifact.id,
              author: "agent",
              content: "FIRST-REPLY",
              target: { artifactId: artifact.id, questionIndex: 0, sectionId: "open-question" },
            }),
            comment({
              id: "c_live2",
              artifactId: artifact.id,
              author: "agent",
              content: "SECOND-REPLY",
              target: { artifactId: artifact.id, questionIndex: 0, sectionId: "open-question" },
            }),
          ],
        },
      });
    });
    expect(within(section).queryByText("SECOND-REPLY")).not.toBeInTheDocument();
  });
});
