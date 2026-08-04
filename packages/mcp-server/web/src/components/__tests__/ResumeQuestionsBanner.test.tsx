import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResumeQuestionsBanner } from "../ResumeQuestionsBanner";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

function seedQuestion(artifactId = "art_1", partial: any = {}): void {
  useArtifactStore.setState((s: any) => ({
    comments: {
      ...s.comments,
      [artifactId]: [
        ...(s.comments[artifactId] ?? []),
        {
          id: `q_${Math.random().toString(36).slice(2, 8)}`,
          sessionId: "s1",
          target: { artifactId },
          author: "human",
          content: "why cookies not JWT?",
          intent: "question",
          acknowledged: false,
          createdAt: new Date().toISOString(),
          ...partial,
        },
      ],
    },
  }));
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ connected: true, activeSessions: [] } as any);
});

describe("#192 — ResumeQuestionsBanner (questions waiting for Claude)", () => {
  it("renders when connected, an unanswered question exists, and no agent is live", () => {
    seedQuestion("art_1");
    render(<ResumeQuestionsBanner />);
    expect(screen.getByText(/1 question waiting for claude/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy resume prompt/i })).toBeInTheDocument();
  });

  it("stays hidden while an agent session is live (agent's turn — it'll answer)", () => {
    useConnectionStore.setState({ connected: true, activeSessions: [{ sessionId: "s1", live: true }] } as any);
    seedQuestion("art_1");
    const { container } = render(<ResumeQuestionsBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden when there are no unanswered questions", () => {
    seedQuestion("art_1", { answeredByCommentId: "x" });
    const { container } = render(<ResumeQuestionsBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden when disconnected (the DisconnectBanner covers that state)", () => {
    useConnectionStore.setState({ connected: false, activeSessions: [] } as any);
    seedQuestion("art_1");
    const { container } = render(<ResumeQuestionsBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("copy button writes a paste-able resume prompt to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    seedQuestion("art_1");
    render(<ResumeQuestionsBanner />);
    await userEvent.click(screen.getByRole("button", { name: /copy resume prompt/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toMatch(/check_feedback/);
    expect(writeText.mock.calls[0]![0]).toMatch(/answer_question/);
  });
});
