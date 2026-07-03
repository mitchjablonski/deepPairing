import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Comment } from "@deeppairing/shared";
import { CommentThread, AskTrigger } from "../CommentThread";

/**
 * Regression: CommentThread rendered ONLY root comments and dropped every
 * reply, so an agent's answer (which carries parentCommentId) was invisible on
 * the artifact even though the conversation rail showed it — a question
 * appeared with no answer. Replies must render nested under their parent.
 */
const mk = (over: Partial<Comment>): Comment =>
  ({
    id: "c",
    sessionId: "s",
    author: "human",
    content: "",
    target: { artifactId: "art_1" },
    parentCommentId: null,
    createdAt: "2026-06-02T00:00:00.000Z",
    ...over,
  }) as any;

describe("CommentThread — renders replies under their parent", () => {
  beforeEach(() => {
    // submitComment isn't exercised here, but the component reads the store.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  it("shows both the human question and the agent's threaded reply", () => {
    const question = mk({ id: "q1", author: "human", content: "How does FAISS compare to BK/LSH?" });
    const answer = mk({
      id: "a1",
      author: "agent",
      content: "FAISS does both jobs better.",
      parentCommentId: "q1",
      createdAt: "2026-06-02T00:01:00.000Z",
    });

    render(<CommentThread artifactId="art_1" comments={[question, answer]} />);

    expect(screen.getByText("How does FAISS compare to BK/LSH?")).toBeInTheDocument();
    // The agent reply (previously dropped) now renders.
    expect(screen.getByText("FAISS does both jobs better.")).toBeInTheDocument();
  });

  it("still shows an orphaned reply whose parent isn't in this filtered set", () => {
    const orphanReply = mk({
      id: "a1",
      author: "agent",
      content: "Orphaned answer",
      parentCommentId: "missing-parent",
    });
    render(<CommentThread artifactId="art_1" comments={[orphanReply]} />);
    expect(screen.getByText("Orphaned answer")).toBeInTheDocument();
  });

  it("U8 — a plain human comment the agent hasn't drained shows just 'delivered' (not 'awaiting agent')", () => {
    const c = mk({ id: "c1", author: "human", content: "Looks good", acknowledged: false } as any);
    render(<CommentThread artifactId="art_1" comments={[c]} />);
    expect(screen.getByText("delivered")).toBeInTheDocument();
    expect(screen.queryByText(/awaiting agent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/seen by agent/i)).not.toBeInTheDocument();
  });

  it("U8 — an unanswered human QUESTION shows 'delivered · awaiting agent' (the agent owes a reply)", () => {
    const c = mk({ id: "c1", author: "human", content: "Which index?", intent: "question", acknowledged: false } as any);
    render(<CommentThread artifactId="art_1" comments={[c]} />);
    expect(screen.getByText(/delivered · awaiting agent/i)).toBeInTheDocument();
  });

  it("shows 'seen by agent' once a human comment has been acknowledged (read-only, derived)", () => {
    const c = mk({ id: "c1", author: "human", content: "Looks good", acknowledged: true } as any);
    render(<CommentThread artifactId="art_1" comments={[c]} />);
    expect(screen.getByText(/seen by agent/i)).toBeInTheDocument();
    expect(screen.queryByText(/awaiting agent/i)).not.toBeInTheDocument();
  });

  it("renders markdown in a comment body — **bold** becomes <strong>, not literal asterisks", () => {
    const c = mk({ id: "m1", author: "agent", content: "This is **important** to note." });
    render(<CommentThread artifactId="art_1" comments={[c]} />);
    const strong = screen.getByText("important");
    expect(strong.tagName).toBe("STRONG"); // rendered, not literal
    expect(screen.queryByText(/\*\*important\*\*/)).not.toBeInTheDocument(); // no raw asterisks
  });
});

describe("AskTrigger popover — U3 outside-click / Escape dismiss", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  it("closes on an outside click and on Escape", async () => {
    render(
      <div>
        <AskTrigger artifactId="art_1" target={{ stepIndex: 0 }} />
        <button>outside</button>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: /ask the agent/i }));
    expect(screen.getByPlaceholderText(/ask the agent to explain/i)).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByPlaceholderText(/ask the agent to explain/i)).not.toBeInTheDocument();

    // reopen, then Escape
    await userEvent.click(screen.getByRole("button", { name: /ask the agent/i }));
    expect(screen.getByPlaceholderText(/ask the agent to explain/i)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByPlaceholderText(/ask the agent to explain/i)).not.toBeInTheDocument();
  });

  it("keeps the popover open + text on a failed send (no stuck 'sending')", async () => {
    const { useArtifactStore } = await import("../../stores/artifact");
    vi.spyOn(useArtifactStore.getState(), "submitComment").mockRejectedValue(new Error("network"));
    render(<AskTrigger artifactId="art_1" target={{ stepIndex: 0 }} />);

    await userEvent.click(screen.getByRole("button", { name: /ask the agent/i }));
    const input = screen.getByPlaceholderText(/ask the agent to explain/i);
    await userEvent.type(input, "why?{Enter}");

    // popover stays open and the draft survives so the user can retry
    expect(screen.getByPlaceholderText(/ask the agent to explain/i)).toBeInTheDocument();
    expect((screen.getByPlaceholderText(/ask the agent to explain/i) as HTMLInputElement).value).toBe("why?");
  });
});

describe("F7 — depth-2 replies render (they used to visibly vanish)", () => {
  it("a reply to a reply appears in the thread", () => {
    const mk = (id: string, parentCommentId: string | null, content: string) =>
      ({ id, parentCommentId, content, artifactId: "a1", author: "human",
         createdAt: `2026-07-01T00:0${id.length}:00.000Z`, target: { artifactId: "a1" } }) as any;
    render(
      <CommentThread
        artifactId="a1"
        comments={[mk("q", null, "the question"), mk("an", "q", "the answer"), mk("fup", "an", "the follow-up")]}
      />,
    );
    expect(screen.getByText("the question")).toBeInTheDocument();
    expect(screen.getByText("the answer")).toBeInTheDocument();
    // Pre-F7 this was neither a root nor a rendered reply.
    expect(screen.getByText("the follow-up")).toBeInTheDocument();
  });
});
