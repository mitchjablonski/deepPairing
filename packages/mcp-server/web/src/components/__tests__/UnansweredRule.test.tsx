import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Comment } from "@deeppairing/shared";
import { AskTrigger, CommentThread } from "../CommentThread";
import { LineCommentChips } from "../LineComments";
import { useArtifactStore } from "../../stores/artifact";
import { computeAttention } from "../../lib/attention";
import { unansweredQuestionIds } from "../../lib/unanswered";

/**
 * #430 PR 1c (docs/design/attention-hierarchy.md §2.8, §8 1c) — ONE
 * "unanswered question" rule: unanswered until an agent reply exists IN ITS
 * THREAD, or the human resolved it. Every surface agrees: AskTrigger's badge +
 * pulse, the comment receipt, LineComments' "awaiting answer", and
 * computeAttention's Waiting count.
 */
let t = 0;
const at = () => `2026-06-01T00:${String(t++).padStart(2, "0")}:00.000Z`;
const q = (id: string, over: Partial<Comment> = {}): Comment => ({
  id, sessionId: "s1", target: { artifactId: "a1", findingIndex: 0 }, parentCommentId: null, author: "human",
  content: `question ${id}`, acknowledged: false, createdAt: at(), intent: "question", ...over,
} as Comment);
const agentReply = (id: string, parent: string): Comment => ({
  id, sessionId: "s1", target: { artifactId: "a1", findingIndex: 0 }, parentCommentId: parent, author: "agent",
  content: `answer to ${parent}`, acknowledged: false, createdAt: at(),
} as Comment);

beforeEach(() => {
  t = 0;
  useArtifactStore.getState().reset();
  useArtifactStore.setState({ artifacts: [{
    id: "a1", sessionId: "s1", type: "research", version: 1, parentId: null, title: "A", status: "draft",
    content: { findings: [] }, agentReasoning: null, createdAt: at(), updatedAt: at(),
  } as any] });
});
const seed = (comments: Comment[]) => useArtifactStore.setState({ comments: { a1: comments } });
const askButton = () => screen.getByRole("button", { name: /ask the agent/i });
const waitingQuestions = (comments: Comment[]) =>
  computeAttention({ artifacts: [], comments: { a1: comments } }).lanes.waiting.filter((w) => w.kind === "question").length;

describe("#430 PR 1c — a threaded agent reply answers the question", () => {
  const comments = () => [q("q1"), agentReply("r1", "q1")];

  it("AskTrigger: no unanswered count, no pulse", () => {
    seed(comments());
    render(<AskTrigger artifactId="a1" target={{ findingIndex: 0 }} />);
    expect(askButton().getAttribute("aria-label")).toBe("Ask the agent about this");
    expect(askButton().className).not.toContain("animate-pulse");
  });

  it("receipt: the question reads '✓ answered', not 'awaiting agent'", () => {
    seed(comments());
    render(<CommentThread artifactId="a1" comments={comments()} />);
    expect(screen.getByText("✓ answered")).toBeInTheDocument();
    expect(screen.queryByText(/awaiting agent/i)).not.toBeInTheDocument();
  });

  it("LineComments: no '⏳ awaiting answer' on the answered line question", () => {
    const line = [q("lq", { target: { artifactId: "a1", lineStart: 3, lineEnd: 3 } }), agentReply("lr", "lq")];
    render(<LineCommentChips comments={line} lineNum={3} artifactId="a1" />);
    expect(screen.queryByText(/awaiting answer/i)).not.toBeInTheDocument();
  });

  it("computeAttention and the rule agree: nothing waiting", () => {
    expect(unansweredQuestionIds(comments()).size).toBe(0);
    expect(waitingQuestions(comments())).toBe(0);
  });
});

describe("#430 PR 1c — a reply on a DIFFERENT thread answers only its own question", () => {
  // Two questions on the same finding; the agent replied to q1 only.
  const comments = () => [q("q1"), q("q2"), agentReply("r1", "q1")];

  it("AskTrigger: exactly ONE unanswered (q2), still pulsing", () => {
    seed(comments());
    render(<AskTrigger artifactId="a1" target={{ findingIndex: 0 }} />);
    expect(askButton().getAttribute("aria-label")).toBe("Ask the agent — 1 unanswered question");
    expect(askButton().className).toContain("animate-pulse");
    fireEvent.click(askButton());
    expect(screen.getByText("answer to q1")).toBeInTheDocument(); // q1 shows its threaded answer
    expect(screen.getAllByText("awaiting answer")).toHaveLength(1); // only q2 waits
  });

  it("receipt: q1 answered, q2 still awaiting", () => {
    seed(comments());
    render(<CommentThread artifactId="a1" comments={comments()} />);
    expect(screen.getAllByText("✓ answered")).toHaveLength(1);
    expect(screen.getAllByText(/delivered · (awaiting agent|agent exited)/)).toHaveLength(1);
  });

  it("computeAttention and the rule agree: q2 waiting, q1 not", () => {
    expect([...unansweredQuestionIds(comments())]).toEqual(["q2"]);
    expect(waitingQuestions(comments())).toBe(1);
  });
});

describe("#430 PR 1c — a human-resolved question is cleared everywhere", () => {
  const comments = () => [q("q1", { humanResolvedAt: at() } as Partial<Comment>)];

  it("AskTrigger, receipt and computeAttention all clear it", () => {
    seed(comments());
    const { unmount } = render(<AskTrigger artifactId="a1" target={{ findingIndex: 0 }} />);
    expect(askButton().getAttribute("aria-label")).toBe("Ask the agent about this");
    unmount();
    render(<CommentThread artifactId="a1" comments={comments()} />);
    expect(screen.getByText("resolved by you")).toBeInTheDocument();
    expect(waitingQuestions(comments())).toBe(0);
  });
});

describe("#448 review — the rule is PER QUESTION: a follow-up never hides the question before it", () => {
  // Q1, then the human's follow-up Q2 as a reply in the SAME thread.
  const followUp = (over: Partial<Comment> = {}) => q("q2", { parentCommentId: "q1", ...over });

  it("two consecutive open questions in one thread are BOTH open everywhere", () => {
    const comments = [q("q1"), followUp()];
    seed(comments);
    const { unmount } = render(<AskTrigger artifactId="a1" target={{ findingIndex: 0 }} />);
    expect(askButton().getAttribute("aria-label")).toBe("Ask the agent — 2 unanswered question");
    unmount();
    const r = render(<CommentThread artifactId="a1" comments={comments} />);
    expect(screen.getAllByText(/delivered · (awaiting agent|agent exited)/)).toHaveLength(2);
    expect(screen.queryByText("✓ answered")).not.toBeInTheDocument();
    r.unmount();
    const line = comments.map((c) => ({ ...c, target: { artifactId: "a1", lineStart: 3, lineEnd: 3 } }));
    render(<LineCommentChips comments={line} lineNum={3} artifactId="a1" />);
    expect(screen.getAllByText(/awaiting answer/i)).toHaveLength(2);
    expect([...unansweredQuestionIds(comments)].sort()).toEqual(["q1", "q2"]);
    expect(waitingQuestions(comments)).toBe(2);
  });

  it("Q1 + a human-RESOLVED follow-up Q2: Q1 is still open", () => {
    const comments = [q("q1"), followUp({ humanResolvedAt: at() } as Partial<Comment>)];
    seed(comments);
    render(<AskTrigger artifactId="a1" target={{ findingIndex: 0 }} />);
    expect(askButton().getAttribute("aria-label")).toBe("Ask the agent — 1 unanswered question");
    expect([...unansweredQuestionIds(comments)]).toEqual(["q1"]);
    expect(waitingQuestions(comments)).toBe(1);
  });

  it("an agent reply AFTER both answers both", () => {
    const comments = [q("q1"), followUp(), agentReply("r", "q2")];
    seed(comments);
    render(<AskTrigger artifactId="a1" target={{ findingIndex: 0 }} />);
    expect(askButton().getAttribute("aria-label")).toBe("Ask the agent about this");
    expect(unansweredQuestionIds(comments).size).toBe(0);
    expect(waitingQuestions(comments)).toBe(0);
  });
});
