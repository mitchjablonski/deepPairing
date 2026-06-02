import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Comment } from "@deeppairing/shared";
import { CommentThread } from "../CommentThread";

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
});
