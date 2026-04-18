import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskTrigger } from "../CommentThread";
import { useArtifactStore } from "../../stores/artifact";

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("AskTrigger", () => {
  it("renders a ? button with default (no questions) tint", () => {
    render(<AskTrigger artifactId="art_x" target={{ findingIndex: 0 }} />);
    const btn = screen.getByRole("button", { name: /ask the agent/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("?");
  });

  it("opens the ask panel on click", async () => {
    render(<AskTrigger artifactId="art_x" target={{ findingIndex: 0 }} />);
    await userEvent.click(screen.getByRole("button", { name: /ask the agent/i }));
    expect(screen.getByPlaceholderText(/ask the agent to explain/i)).toBeInTheDocument();
  });

  it("submits with intent: 'question' when Ask is clicked", async () => {
    render(<AskTrigger artifactId="art_x" target={{ findingIndex: 0 }} />);
    await userEvent.click(screen.getByRole("button", { name: /ask the agent/i }));

    const input = screen.getByPlaceholderText(/ask the agent to explain/i);
    await userEvent.type(input, "why this approach?");
    await userEvent.click(screen.getByRole("button", { name: /^Ask$/ }));

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.content).toBe("why this approach?");
    expect(body.intent).toBe("question");
    expect(body.target.artifactId).toBe("art_x");
    expect(body.target.findingIndex).toBe(0);
  });

  it("Enter submits; Escape closes without submitting", async () => {
    render(<AskTrigger artifactId="art_x" target={{ findingIndex: 0 }} />);
    await userEvent.click(screen.getByRole("button", { name: /ask the agent/i }));

    const input = screen.getByPlaceholderText(/ask the agent to explain/i);
    // Escape closes
    await userEvent.type(input, "why?");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText(/ask the agent to explain/i)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("pill variant shows label text", () => {
    render(<AskTrigger artifactId="art_x" target={{ findingIndex: 0 }} variant="pill" />);
    expect(screen.getByText(/Ask why/i)).toBeInTheDocument();
  });

  it("pulses + labels unanswered questions", async () => {
    // Seed an unanswered question comment
    useArtifactStore.getState().addComment({
      id: "cmt_q1",
      sessionId: "s1",
      target: { artifactId: "art_x", findingIndex: 0 } as any,
      parentCommentId: null,
      author: "human",
      content: "why?",
      acknowledged: false,
      createdAt: "2026-04-17T10:00:00.000Z",
      intent: "question",
    } as any);

    render(<AskTrigger artifactId="art_x" target={{ findingIndex: 0 }} />);
    const btn = screen.getByRole("button", { name: /1 unanswered question/i });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toMatch(/animate-pulse/);
    expect(btn).toHaveTextContent("1"); // count badge
  });

  it("shows answered questions with the agent's reply inline", async () => {
    const s = useArtifactStore.getState();
    s.addComment({
      id: "cmt_q1",
      sessionId: "s1",
      target: { artifactId: "art_x", findingIndex: 0 } as any,
      parentCommentId: null,
      author: "human",
      content: "why this approach?",
      acknowledged: true,
      createdAt: "2026-04-17T10:00:00.000Z",
      intent: "question",
      answeredByCommentId: "cmt_a1",
    } as any);
    s.addComment({
      id: "cmt_a1",
      sessionId: "s1",
      target: { artifactId: "art_x", findingIndex: 0 } as any,
      parentCommentId: "cmt_q1",
      author: "agent",
      content: "because Y",
      acknowledged: true,
      createdAt: "2026-04-17T10:01:00.000Z",
    });

    render(<AskTrigger artifactId="art_x" target={{ findingIndex: 0 }} />);
    await userEvent.click(screen.getByRole("button", { name: /ask the agent/i }));

    expect(screen.getByText(/why this approach/i)).toBeInTheDocument();
    expect(screen.getByText(/because Y/i)).toBeInTheDocument();
  });
});
