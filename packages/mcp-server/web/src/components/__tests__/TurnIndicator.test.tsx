import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TurnIndicator } from "../TurnIndicator";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

function seedConnected(): void {
  useConnectionStore.setState({ connected: true } as any);
}

function seedArtifact(overrides: any = {}): void {
  useArtifactStore.setState((s: any) => ({
    artifacts: [
      ...s.artifacts,
      {
        id: "art_1",
        sessionId: "s1",
        type: "research",
        version: 1,
        parentId: null,
        title: "x",
        status: "approved",
        content: {},
        agentReasoning: null,
        createdAt: "2026-04-20T10:00:00Z",
        updatedAt: "2026-04-20T10:00:00Z",
        ...overrides,
      },
    ],
  }));
}

function seedComment(artifactId: string, partial: any = {}): void {
  useArtifactStore.setState((s: any) => ({
    comments: {
      ...s.comments,
      [artifactId]: [
        ...(s.comments[artifactId] ?? []),
        {
          id: `cmt_${Math.random().toString(36).slice(2, 8)}`,
          sessionId: "s1",
          target: { artifactId },
          author: "human",
          content: "why?",
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
  useConnectionStore.setState({ connected: false } as any);
});

describe("TurnIndicator — Q4 unanswered-questions badge", () => {
  it("does NOT render the badge when there are no unanswered questions", () => {
    seedConnected();
    seedArtifact();
    render(<TurnIndicator />);
    expect(screen.queryByText(/question.* waiting/i)).not.toBeInTheDocument();
  });

  it("renders '1 question waiting' when a human question-intent comment has no answer", () => {
    seedConnected();
    seedArtifact({ id: "art_1" });
    seedComment("art_1");
    render(<TurnIndicator />);
    expect(screen.getByText(/1 question waiting/i)).toBeInTheDocument();
  });

  it("pluralizes correctly and counts across multiple artifacts", () => {
    seedConnected();
    seedArtifact({ id: "art_1" });
    seedArtifact({ id: "art_2" });
    seedComment("art_1");
    seedComment("art_1");
    seedComment("art_2");
    render(<TurnIndicator />);
    expect(screen.getByText(/3 questions waiting/i)).toBeInTheDocument();
  });

  it("hides the badge when all questions have been answered", () => {
    seedConnected();
    seedArtifact({ id: "art_1" });
    seedComment("art_1", { answeredByCommentId: "cmt_answer" });
    render(<TurnIndicator />);
    expect(screen.queryByText(/question.* waiting/i)).not.toBeInTheDocument();
  });

  it("click selects the artifact containing the oldest unanswered question", async () => {
    seedConnected();
    seedArtifact({ id: "art_1" });
    seedArtifact({ id: "art_2" });
    seedComment("art_2", { createdAt: "2026-04-21T00:00:00Z" });
    seedComment("art_1", { createdAt: "2026-04-20T00:00:00Z" });
    render(<TurnIndicator />);
    await userEvent.click(screen.getByRole("button", { name: /2 questions waiting/i }));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("art_1");
  });

  it("ignores agent-authored comments (those are answers, not questions)", () => {
    seedConnected();
    seedArtifact({ id: "art_1" });
    seedComment("art_1", { author: "agent" });
    render(<TurnIndicator />);
    expect(screen.queryByText(/question.* waiting/i)).not.toBeInTheDocument();
  });

  it("does NOT count a question the human resolved themselves (humanResolvedAt set)", () => {
    seedConnected();
    seedArtifact({ id: "art_1" });
    seedComment("art_1", { humanResolvedAt: "2026-04-22T00:00:00Z" });
    render(<TurnIndicator />);
    expect(screen.queryByText(/question.* waiting/i)).not.toBeInTheDocument();
  });

  it("still counts a sibling unresolved question when another was human-resolved", () => {
    seedConnected();
    seedArtifact({ id: "art_1" });
    seedComment("art_1", { humanResolvedAt: "2026-04-22T00:00:00Z" });
    seedComment("art_1"); // still open
    render(<TurnIndicator />);
    expect(screen.getByText(/1 question waiting/i)).toBeInTheDocument();
  });
});

describe("TurnIndicator — U2 agent liveness", () => {
  it("shows 'Up to date' (not a forever 'Agent working' pulse) once activity is stale", () => {
    seedConnected();
    seedArtifact({ status: "approved", createdAt: "2026-04-20T10:00:00Z", updatedAt: "2026-04-20T10:00:00Z" });
    render(<TurnIndicator />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
    expect(screen.queryByText(/agent working/i)).not.toBeInTheDocument();
  });

  it("shows 'Agent working' while there is recent activity", () => {
    seedConnected();
    const now = new Date().toISOString();
    seedArtifact({ status: "approved", createdAt: now, updatedAt: now });
    render(<TurnIndicator />);
    expect(screen.getByText(/agent working/i)).toBeInTheDocument();
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });

  it("a freshly-connected session with nothing yet shows 'Agent working' (not 'Up to date')", () => {
    seedConnected(); // no artifacts/comments
    render(<TurnIndicator />);
    expect(screen.getByText(/agent working/i)).toBeInTheDocument();
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });

  it("re-arms: new activity flips a stale 'Up to date' back to 'Agent working'", () => {
    seedConnected();
    seedArtifact({ id: "old", status: "approved", createdAt: "2026-04-20T10:00:00Z", updatedAt: "2026-04-20T10:00:00Z" });
    const { rerender } = render(<TurnIndicator />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
    // fresh activity arrives
    const now = new Date().toISOString();
    act(() => { seedArtifact({ id: "fresh", status: "approved", createdAt: now, updatedAt: now }); });
    rerender(<TurnIndicator />);
    expect(screen.getByText(/agent working/i)).toBeInTheDocument();
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });
});
