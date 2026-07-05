import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Comment } from "@deeppairing/shared";
import { LineComposer, LineCommentChips } from "../LineComments";
import { useArtifactStore } from "../../stores/artifact";

beforeEach(() => {
  useArtifactStore.getState().reset();
});

// The UX7d test below spies submitComment with mockRejectedValue; without a
// restore that mock leaks into every later test in this file (submitComment
// never reaches fetch). Restore spies + unstub globals between tests.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function agentComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "ag1",
    sessionId: "s1",
    target: { artifactId: "art_1", lineStart: 5, lineEnd: 5 },
    parentCommentId: null,
    author: "agent",
    content: "here's the answer",
    acknowledged: false,
    createdAt: "2026-04-26T10:00:00.000Z",
    ...overrides,
  } as Comment;
}

describe("LineComposer — UX7d resilient submit", () => {
  it("re-enables the composer + keeps the text when submit fails (was stuck disabled forever)", async () => {
    vi.spyOn(useArtifactStore.getState(), "submitComment").mockRejectedValue(new Error("network"));
    const onClose = vi.fn();
    render(
      <LineComposer lineNum={1} artifactId="art_1" mode="comment" setMode={() => {}} existingComments={[]} onClose={onClose} />,
    );
    const input = screen.getByPlaceholderText(/add a comment on this line/i);
    await userEvent.type(input, "why this?");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true }); // ⌘⏎ submit

    // pre-fix: submitting stayed true forever (composer permanently disabled) and
    // onClose was unreachable. Now: stays open, re-enables, keeps the draft.
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(input).not.toBeDisabled());
    expect((input as HTMLInputElement).value).toBe("why this?");
  });
});

describe("LineCommentChips — I4 reply ask-mode", () => {
  it("a plain reply carries NO intent (default), threaded under the parent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ comment: { id: "r1" } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<LineCommentChips lineNum={5} comments={[agentComment()]} artifactId="art_1" />);
    await userEvent.click(screen.getByRole("button", { name: /reply to this comment/i }));
    await userEvent.type(screen.getByPlaceholderText(/reply to the agent/i), "thanks!");
    await userEvent.click(screen.getByRole("button", { name: /^Reply$/ }));

    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body);
    expect(body.content).toBe("thanks!");
    expect(body.parentCommentId).toBe("ag1");
    expect(body.intent).toBeUndefined();
  });

  it("a reply flipped to Ask carries intent:'question' + parentCommentId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ comment: { id: "r1" } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<LineCommentChips lineNum={5} comments={[agentComment()]} artifactId="art_1" />);
    await userEvent.click(screen.getByRole("button", { name: /reply to this comment/i }));
    // Flip to Ask.
    await userEvent.click(screen.getByRole("button", { name: /^ask$/i }));
    await userEvent.type(screen.getByPlaceholderText(/ask the agent a follow-up/i), "but what about Y?");
    const askBtns = screen.getAllByRole("button", { name: /^Ask$/ });
    await userEvent.click(askBtns[askBtns.length - 1]!);

    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body);
    expect(body.content).toBe("but what about Y?");
    expect(body.intent).toBe("question");
    expect(body.parentCommentId).toBe("ag1");
  });
});
