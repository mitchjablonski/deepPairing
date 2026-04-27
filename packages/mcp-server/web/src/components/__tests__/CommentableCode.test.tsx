import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommentableCode } from "../CommentableCode";
import { useArtifactStore } from "../../stores/artifact";

// The useHighlightedCode hook uses shiki which is async; stub the hook to
// return null so CommentableCode renders the plain-text fallback path. We
// only care about interactions, not syntax colors.
vi.mock("../../hooks/useHighlightedCode", () => ({
  useHighlightedCode: () => ({ lines: null }),
}));

const code = [
  "function hash(pw) {",
  "  return bcrypt.hash(pw, 10);",
  "}",
].join("\n");

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("CommentableCode", () => {
  it("renders lines with correct line numbers starting from lineStart", () => {
    render(<CommentableCode code={code} lineStart={42} artifactId="art_x" filePath="a.ts" />);
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("43")).toBeInTheDocument();
    expect(screen.getByText("44")).toBeInTheDocument();
  });

  it("shows ? (ask) and + (comment) gutter buttons for each line", () => {
    render(<CommentableCode code={code} lineStart={1} artifactId="art_x" filePath="a.ts" />);
    const askButtons = screen.getAllByRole("button", { name: /ask a question about this line/i });
    const commentButtons = screen.getAllByRole("button", { name: /add a comment on this line/i });
    expect(askButtons).toHaveLength(3);
    expect(commentButtons).toHaveLength(3);
  });

  it("clicking + opens Comment mode with the inline input", async () => {
    render(<CommentableCode code={code} lineStart={1} artifactId="art_x" filePath="a.ts" />);
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    await userEvent.click(commentBtns[1]);
    expect(screen.getByPlaceholderText(/add a comment on this line/i)).toBeInTheDocument();
  });

  it("clicking ? opens Ask mode with the ask placeholder", async () => {
    render(<CommentableCode code={code} lineStart={1} artifactId="art_x" filePath="a.ts" />);
    const askBtns = screen.getAllByRole("button", { name: /ask a question about this line/i });
    await userEvent.click(askBtns[0]);
    expect(screen.getByPlaceholderText(/ask the agent about this line/i)).toBeInTheDocument();
  });

  it("Ask mode submits the comment with intent: 'question' on that line", async () => {
    render(<CommentableCode code={code} lineStart={10} artifactId="art_x" filePath="auth.ts" />);
    const askBtns = screen.getAllByRole("button", { name: /ask a question about this line/i });
    await userEvent.click(askBtns[1]); // line 11
    const input = screen.getByPlaceholderText(/ask the agent about this line/i);
    await userEvent.type(input, "why 10 rounds?");
    // Two "Ask" buttons in play now — the tab and the submit. The submit is
    // the last one in DOM order.
    const askButtons = screen.getAllByRole("button", { name: /^Ask$/ });
    await userEvent.click(askButtons[askButtons.length - 1]);

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.content).toBe("why 10 rounds?");
    expect(body.intent).toBe("question");
    expect(body.target.lineStart).toBe(11);
    expect(body.target.filePath).toBe("auth.ts");
  });

  it("Comment mode submits without intent", async () => {
    render(<CommentableCode code={code} lineStart={1} artifactId="art_x" filePath="a.ts" />);
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    await userEvent.click(commentBtns[0]);
    const input = screen.getByPlaceholderText(/add a comment on this line/i);
    await userEvent.type(input, "cleanup needed");
    // "Comment" is both the panel tab and the submit button; grab the submit
    // one (the one inside the form row — it's the last "Comment" button).
    const submitButtons = screen.getAllByRole("button", { name: /^Comment$/ });
    await userEvent.click(submitButtons[submitButtons.length - 1]);

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.content).toBe("cleanup needed");
    expect(body.intent).toBeUndefined();
  });

  it("Suggest mode pre-fills the textarea with the current line", async () => {
    render(<CommentableCode code={code} lineStart={1} artifactId="art_x" filePath="a.ts" />);
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    await userEvent.click(commentBtns[1]); // line 2 → "  return bcrypt.hash(pw, 10);"
    await userEvent.click(screen.getByRole("button", { name: /^Suggest$/ }));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("  return bcrypt.hash(pw, 10);");
  });

  it("R2 — span input is hidden in Suggest mode (suggestions stay single-line)", async () => {
    render(<CommentableCode code={code} lineStart={1} artifactId="art_x" filePath="a.ts" />);
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    await userEvent.click(commentBtns[0]);
    // Visible in comment mode
    expect(screen.getByLabelText(/comment end line/i)).toBeInTheDocument();
    // Hidden in suggest mode
    await userEvent.click(screen.getByRole("button", { name: /^Suggest$/ }));
    expect(screen.queryByLabelText(/comment end line/i)).not.toBeInTheDocument();
  });

  it("R2 — submitting with extended end line sends a span comment", async () => {
    render(<CommentableCode code={code} lineStart={10} artifactId="art_x" filePath="auth.ts" />);
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    await userEvent.click(commentBtns[0]); // line 10
    // Extend the span end to line 12 (covers all 3 lines).
    const endInput = screen.getByLabelText(/comment end line/i) as HTMLInputElement;
    await userEvent.clear(endInput);
    await userEvent.type(endInput, "12");
    const input = screen.getByPlaceholderText(/add a comment on this line/i);
    await userEvent.type(input, "the whole hash function");
    const submitBtns = screen.getAllByRole("button", { name: /^Comment$/ });
    await userEvent.click(submitBtns[submitBtns.length - 1]);

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.target.lineStart).toBe(10);
    expect(body.target.lineEnd).toBe(12);
    expect(body.content).toBe("the whole hash function");
  });

  it("R2 — caps lineEnd at the file's last line (no out-of-range spans)", async () => {
    render(<CommentableCode code={code} lineStart={1} artifactId="art_x" filePath="a.ts" />);
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    await userEvent.click(commentBtns[0]); // line 1, file has 3 lines
    const endInput = screen.getByLabelText(/comment end line/i) as HTMLInputElement;
    // Try to extend past EOF.
    await userEvent.clear(endInput);
    await userEvent.type(endInput, "99");
    const input = screen.getByPlaceholderText(/add a comment on this line/i);
    await userEvent.type(input, "spans the file");
    const submitBtns = screen.getAllByRole("button", { name: /^Comment$/ });
    await userEvent.click(submitBtns[submitBtns.length - 1]);

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.target.lineEnd).toBe(3); // clamped to total lines
  });

  it("R2 — backwards range (end < start) clamps to start, never produces a negative span", async () => {
    render(<CommentableCode code={code} lineStart={1} artifactId="art_x" filePath="a.ts" />);
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    await userEvent.click(commentBtns[1]); // line 2
    const endInput = screen.getByLabelText(/comment end line/i) as HTMLInputElement;
    // The input enforces min=lineStart at the HTML level, but the submit
    // path also clamps defensively in case the user bypasses the input.
    // Type a backwards value: HTML clamps it (or the user pastes), and
    // even if it slips through state, handleSubmit floor-clamps to lineNum.
    await userEvent.clear(endInput);
    await userEvent.type(endInput, "1");
    const input = screen.getByPlaceholderText(/add a comment on this line/i);
    await userEvent.type(input, "test");
    const submitBtns = screen.getAllByRole("button", { name: /^Comment$/ });
    await userEvent.click(submitBtns[submitBtns.length - 1]);

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.target.lineEnd).toBeGreaterThanOrEqual(body.target.lineStart);
  });

  it("R1 — continuation lines render a compact ↳ marker, not a duplicate full chip", () => {
    const spanComment = {
      id: "c1",
      sessionId: "s",
      target: { artifactId: "art_x", lineStart: 1, lineEnd: 3 },
      parentCommentId: null,
      author: "human" as const,
      content: "spans the whole function",
      acknowledged: false,
      createdAt: "2026-04-26T10:00:00.000Z",
    };
    const byLine = new Map<number, any[]>();
    // Bucket the same comment into every line in its span (the
    // ResearchArtifact builder does this; here we hand-build to test the
    // render).
    byLine.set(1, [spanComment]);
    byLine.set(2, [spanComment]);
    byLine.set(3, [spanComment]);

    render(
      <CommentableCode
        code={code}
        lineStart={1}
        artifactId="art_x"
        filePath="a.ts"
        commentsByLine={byLine}
      />,
    );
    // The full chip with the comment text appears exactly once.
    expect(screen.getAllByText(/spans the whole function/i)).toHaveLength(1);
    // The continuation marker shows on lines 2 and 3 with the L1 link.
    const markers = screen.getAllByText((_, el) => {
      const txt = el?.textContent ?? "";
      return /comment from\s*L1/.test(txt);
    });
    expect(markers.length).toBeGreaterThanOrEqual(2);
  });

  it("Reply — agent comments expose a Reply button; submit posts with parentCommentId", async () => {
    // The user couldn't reply to the agent's answer in-thread; their only
    // option was to comment on the line again, producing a sibling chip
    // that broke the thread visually. The Reply button anchors a
    // composer to the specific agent comment and posts with
    // parentCommentId.
    const agentComment = {
      id: "ans1",
      sessionId: "s",
      target: { artifactId: "art_x", lineStart: 2, lineEnd: 2 },
      parentCommentId: "q1",
      author: "agent" as const,
      content: "I considered X but rejected because Y",
      acknowledged: true,
      createdAt: "2026-04-26T10:00:00.000Z",
    };
    const byLine = new Map<number, any[]>();
    byLine.set(2, [agentComment]);
    render(
      <CommentableCode
        code={code}
        lineStart={1}
        artifactId="art_x"
        filePath="a.ts"
        commentsByLine={byLine}
      />,
    );
    const replyBtn = screen.getByRole("button", { name: /reply to this comment/i });
    await userEvent.click(replyBtn);
    const reply = screen.getByPlaceholderText(/reply to the agent/i);
    await userEvent.type(reply, "but Y doesn't apply because Z");
    // Submit via the Reply button next to the textarea (the trigger is
    // the lowercased "Reply to this comment" label; submit is "Reply").
    const submitBtn = screen.getAllByRole("button", { name: /^Reply$/ }).pop()!;
    await userEvent.click(submitBtn);

    const body = JSON.parse((fetch as any).mock.calls.at(-1)[1].body);
    expect(body.content).toBe("but Y doesn't apply because Z");
    expect(body.parentCommentId).toBe("ans1");
    // Reply inherits the parent's anchor.
    expect(body.target.lineStart).toBe(2);
  });

  it("Reply — does NOT show a Reply button on human comments (only on agent comments)", () => {
    const humanComment = {
      id: "h1",
      sessionId: "s",
      target: { artifactId: "art_x", lineStart: 2, lineEnd: 2 },
      parentCommentId: null,
      author: "human" as const,
      content: "looks fragile",
      acknowledged: false,
      createdAt: "2026-04-26T10:00:00.000Z",
    };
    const byLine = new Map<number, any[]>();
    byLine.set(2, [humanComment]);
    render(
      <CommentableCode
        code={code}
        lineStart={1}
        artifactId="art_x"
        filePath="a.ts"
        commentsByLine={byLine}
      />,
    );
    expect(screen.queryByRole("button", { name: /reply to this comment/i })).not.toBeInTheDocument();
  });

  it("R1 — single-line comment shows full chip with no continuation marker", () => {
    const singleComment = {
      id: "c2",
      sessionId: "s",
      target: { artifactId: "art_x", lineStart: 2, lineEnd: 2 },
      parentCommentId: null,
      author: "human" as const,
      content: "just this line",
      acknowledged: false,
      createdAt: "2026-04-26T10:00:00.000Z",
    };
    const byLine = new Map<number, any[]>();
    byLine.set(2, [singleComment]);
    render(
      <CommentableCode
        code={code}
        lineStart={1}
        artifactId="art_x"
        filePath="a.ts"
        commentsByLine={byLine}
      />,
    );
    expect(screen.getByText(/just this line/i)).toBeInTheDocument();
    expect(screen.queryByText(/comment from L/i)).not.toBeInTheDocument();
  });

  it("switching between Comment / Ask / Suggest modes changes the active input", async () => {
    render(<CommentableCode code={code} lineStart={1} artifactId="art_x" filePath="a.ts" />);
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    await userEvent.click(commentBtns[0]);

    // Default mode shows the Comment placeholder
    expect(screen.getByPlaceholderText(/add a comment on this line/i)).toBeInTheDocument();

    // Switch to Ask — the tab button's accessible name is "Ask"; there's no
    // submit button yet since the input is empty, so this matches uniquely.
    await userEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
    expect(screen.getByPlaceholderText(/ask the agent about this line/i)).toBeInTheDocument();

    // Switch to Suggest — textarea replaces input; Submit Suggestion appears
    await userEvent.click(screen.getByRole("button", { name: /^Suggest$/ }));
    expect(screen.getByRole("button", { name: /submit suggestion/i })).toBeInTheDocument();
  });
});
