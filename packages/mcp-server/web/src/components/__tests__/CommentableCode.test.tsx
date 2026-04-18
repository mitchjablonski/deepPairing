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
