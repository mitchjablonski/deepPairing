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
  useConnectionStore.setState({ connected: false, agentActivityAt: null, agentActiveSince: null } as any);
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

describe("TurnIndicator — UX1: a draft code_change is 'your turn' (matches PendingBanner)", () => {
  it("shows 'Your turn — 1 change' for a draft code_change (was 'Agent working')", () => {
    seedConnected();
    seedArtifact({ id: "cc", type: "code_change", status: "draft" });
    render(<TurnIndicator />);
    expect(screen.getByText(/your turn/i)).toBeInTheDocument();
    expect(screen.getByText(/1 change/i)).toBeInTheDocument();
    expect(screen.queryByText(/agent working/i)).not.toBeInTheDocument();
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

  it("C2 — a freshly-connected session with NO signal shows 'Connected — waiting', not the unfalsifiable 'Agent working'", () => {
    seedConnected(); // no artifacts/comments/heartbeats
    render(<TurnIndicator />);
    expect(screen.getByText(/connected — waiting/i)).toBeInTheDocument();
    expect(screen.queryByText(/agent working/i)).not.toBeInTheDocument();
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

describe("B2 — heartbeat liveness + elapsed label", () => {
  it("shows 'Agent working · Nm' from the agent_activity heartbeat even with stale artifacts", () => {
    seedConnected();
    const now = Date.now();
    // Artifacts are old (past the 45s idle cutoff) — pre-B2 this flipped to
    // "Up to date" while the agent was mid-edit-run. The heartbeat keeps it
    // honest and adds elapsed time.
    seedArtifact({ id: "old", status: "approved", createdAt: "2026-01-01T00:00:00Z" });
    useConnectionStore.setState({
      agentActivityAt: now - 1_000,
      agentActiveSince: now - 3 * 60_000,
    } as any);
    render(<TurnIndicator />);
    expect(screen.getByText(/agent working · 3m/i)).toBeInTheDocument();
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });

  it("stays 'Up to date' when the heartbeat is also stale", () => {
    seedConnected();
    const stale = Date.now() - 10 * 60_000;
    seedArtifact({ id: "old", status: "approved", createdAt: "2026-01-01T00:00:00Z" });
    useConnectionStore.setState({ agentActivityAt: stale, agentActiveSince: stale } as any);
    render(<TurnIndicator />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
  });
});

describe("C2 — honest t=0: no signal must not claim 'Agent working'", () => {
  // (the zero-signal case itself is asserted in the rewritten U2 test above)
  it("flips to 'Agent working' once the first heartbeat arrives", () => {
    seedConnected();
    useConnectionStore.setState({ agentActivityAt: Date.now(), agentActiveSince: Date.now() } as any);
    render(<TurnIndicator />);
    expect(screen.getByText(/agent working/i)).toBeInTheDocument();
    expect(screen.queryByText(/connected — waiting/i)).not.toBeInTheDocument();
  });
});

describe("B1 — the 'Your turn' pill is a jump button, not a dead label", () => {
  it("clicking jumps to the first pending artifact and cycles on repeat clicks", async () => {
    const user = userEvent.setup();
    seedConnected();
    seedArtifact({ id: "d1", status: "draft", title: "first" });
    seedArtifact({ id: "d2", status: "draft", title: "second" });
    render(<TurnIndicator />);

    const pill = screen.getByRole("button", { name: /your turn/i });
    await user.click(pill);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("d1");
    await user.click(pill);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("d2");
    await user.click(pill); // wraps
    expect(useArtifactStore.getState().selectedArtifactId).toBe("d1");
  });
});

describe("F8 (M6) — the questions badge stops promising check-ins from dead sessions", () => {
  it("says 'agent exited' when every unanswered question's owning session is dead", () => {
    useConnectionStore.setState({
      connected: true,
      sessionId: "s1",
      activeSessions: [{ sessionId: "s1", live: false }],
    } as any);
    useArtifactStore.setState({
      comments: {
        art_q: [{
          id: "c_q", artifactId: "art_q", sessionId: "s1", author: "human",
          intent: "question", content: "?", createdAt: "2026-07-01T00:00:00.000Z",
          target: { artifactId: "art_q" },
        } as any],
      },
    });
    render(<TurnIndicator />);
    expect(screen.getByText(/agent exited/i)).toBeInTheDocument();
  });
});
