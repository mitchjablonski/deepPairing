/**
 * W1 — conversation rail tests. Pin the load-bearing behaviors:
 *   - Reads comments cross-artifact from the existing artifact store
 *     (no backend roundtrip).
 *   - Groups by artifact, newest activity first.
 *   - Threads replies under their parent (parentCommentId).
 *   - Marks human questions with no reply as "unanswered".
 *   - Click a row → dispatches dp:focus-artifact so the artifact panel
 *     scrolls into view (the same wiring the question_answered toast uses).
 *   - Esc closes; click-outside closes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact, Comment } from "@deeppairing/shared";
import { ConversationRail } from "../ConversationRail";
import { useArtifactStore } from "../../stores/artifact";

function artifact(id: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: `Artifact ${id}`,
    status: "draft",
    content: { summary: "x", findings: [] },
    agentReasoning: null,
    createdAt: "2026-04-26T10:00:00.000Z",
    updatedAt: "2026-04-26T10:00:00.000Z",
    ...overrides,
  };
}

function comment(opts: {
  id: string;
  artifactId: string;
  author: "human" | "agent";
  content: string;
  createdAt: string;
  intent?: "question" | "comment" | "suggestion";
  parentCommentId?: string;
  target?: Record<string, unknown>;
}): Comment {
  return {
    id: opts.id,
    sessionId: "s1",
    target: { artifactId: opts.artifactId, ...opts.target },
    parentCommentId: opts.parentCommentId ?? null,
    author: opts.author,
    content: opts.content,
    intent: opts.intent,
    answeredByCommentId: null,
    acknowledged: false,
    createdAt: opts.createdAt,
  };
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  // W2 — clear the persisted "last opened" so each test starts fresh.
  // sessionStorage may not exist in some envs; guard.
  try { sessionStorage.removeItem("dp:rail-last-opened-at"); } catch {}
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConversationRail (W1)", () => {
  it("renders an empty-state when no comments exist anywhere", () => {
    render(<ConversationRail onClose={() => {}} />);
    expect(screen.getByText(/no comments in this session yet/i)).toBeInTheDocument();
  });

  it("lists comments across multiple artifacts in one feed", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings v1" }));
    s.addArtifact(artifact("a2", { title: "Plan v1", type: "plan" }));
    s.addComment(comment({ id: "c_a1", artifactId: "a1", author: "human", content: "looks off here", createdAt: "2026-04-26T10:01:00.000Z" }));
    s.addComment(comment({ id: "c_a2", artifactId: "a2", author: "human", content: "rename step 2?", createdAt: "2026-04-26T10:02:00.000Z" }));
    render(<ConversationRail onClose={() => {}} />);
    // Both artifacts and both comments visible.
    expect(screen.getByText("Findings v1")).toBeInTheDocument();
    expect(screen.getByText("Plan v1")).toBeInTheDocument();
    expect(screen.getByText("looks off here")).toBeInTheDocument();
    expect(screen.getByText("rename step 2?")).toBeInTheDocument();
  });

  it("orders artifact groups by their most recent comment activity (newest first)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a_old", { title: "Stale artifact" }));
    s.addArtifact(artifact("a_new", { title: "Hot artifact" }));
    s.addComment(comment({ id: "c_old", artifactId: "a_old", author: "human", content: "old", createdAt: "2026-04-26T10:00:00.000Z" }));
    s.addComment(comment({ id: "c_new", artifactId: "a_new", author: "human", content: "new", createdAt: "2026-04-26T11:00:00.000Z" }));

    render(<ConversationRail onClose={() => {}} />);
    const titles = screen.getAllByText(/(Stale|Hot) artifact/);
    // First in DOM order should be the hot one.
    expect(titles[0]).toHaveTextContent("Hot artifact");
    expect(titles[1]).toHaveTextContent("Stale artifact");
  });

  it("threads agent replies under their parent question (parentCommentId)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    s.addComment(comment({
      id: "q1", artifactId: "a1", author: "human", intent: "question",
      content: "why bcrypt 4 rounds?", createdAt: "2026-04-26T10:00:00.000Z",
      target: { lineStart: 23 },
    }));
    s.addComment(comment({
      id: "ans1", artifactId: "a1", author: "agent", parentCommentId: "q1",
      content: "rounds=4 was a copy-paste error from the test fixture", createdAt: "2026-04-26T10:01:00.000Z",
      target: { lineStart: 23 },
    }));

    render(<ConversationRail onClose={() => {}} />);
    // Both visible. The reply is a separate row indented under the question.
    expect(screen.getByText("why bcrypt 4 rounds?")).toBeInTheDocument();
    expect(screen.getByText(/rounds=4 was a copy-paste error/)).toBeInTheDocument();
    // The threaded reply has the ↳ indicator. (W3 added a "↳ Reply"
    // affordance which also matches /↳/, so be explicit: getAllByText
    // and assert at least one ↳ exists in the rendered output.)
    expect(screen.getAllByText(/↳/).length).toBeGreaterThan(0);
  });

  it("flags an unanswered human question with the awaiting-reply marker", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    s.addComment(comment({
      id: "q1", artifactId: "a1", author: "human", intent: "question",
      content: "is this the same issue as #14?", createdAt: "2026-04-26T10:00:00.000Z",
    }));
    render(<ConversationRail onClose={() => {}} />);
    expect(screen.getByText(/awaiting the agent's answer/i)).toBeInTheDocument();
    expect(screen.getByText(/1 unanswered question/i)).toBeInTheDocument();
  });

  it("does NOT count a human question the human resolved themselves (humanResolvedAt set)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    const q = comment({
      id: "q1", artifactId: "a1", author: "human", intent: "question",
      content: "never mind, figured it out", createdAt: "2026-04-26T10:00:00.000Z",
    });
    (q as any).humanResolvedAt = "2026-04-26T11:00:00.000Z";
    s.addComment(q);
    render(<ConversationRail onClose={() => {}} />);
    expect(screen.queryByText(/1 unanswered question/i)).not.toBeInTheDocument();
    // U5 — the inline thread marker must agree with the pill: a resolved
    // question is NOT "awaiting agent answer" (the shadowed predicate bug).
    expect(screen.queryByText(/awaiting the agent's answer/i)).not.toBeInTheDocument();
  });

  it("does NOT flag a question once an agent reply exists for it", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    s.addComment(comment({
      id: "q1", artifactId: "a1", author: "human", intent: "question",
      content: "Q", createdAt: "2026-04-26T10:00:00.000Z",
    }));
    s.addComment(comment({
      id: "ans1", artifactId: "a1", author: "agent", parentCommentId: "q1",
      content: "A", createdAt: "2026-04-26T10:01:00.000Z",
    }));
    render(<ConversationRail onClose={() => {}} />);
    expect(screen.queryByText(/awaiting the agent's answer/i)).not.toBeInTheDocument();
  });

  it("clicking a thread row dispatches dp:focus-artifact with the right id", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a_focus", { title: "Pick me" }));
    s.addComment(comment({ id: "c1", artifactId: "a_focus", author: "human", content: "focus this one", createdAt: "2026-04-26T10:00:00.000Z" }));

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<ConversationRail onClose={() => {}} />);
    await userEvent.click(screen.getByText("focus this one"));
    const calls = dispatchSpy.mock.calls.map((c) => c[0] as CustomEvent);
    const focus = calls.find((e) => e.type === "dp:focus-artifact");
    expect(focus).toBeDefined();
    expect((focus as any).detail).toEqual({ artifactId: "a_focus" });
  });

  it("a11y — the thread row jump is keyboard-operable (Enter dispatches dp:focus-artifact)", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a_kbd", { title: "Pick me" }));
    s.addComment(comment({ id: "ck", artifactId: "a_kbd", author: "human", content: "jump via keyboard", createdAt: "2026-04-26T10:00:00.000Z" }));

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<ConversationRail onClose={() => {}} />);
    const row = screen.getByRole("button", { name: /jump to this comment/i });
    fireEvent.keyDown(row, { key: "Enter" });
    const focus = dispatchSpy.mock.calls.map((c) => c[0] as CustomEvent).find((e) => e.type === "dp:focus-artifact");
    expect((focus as any)?.detail).toEqual({ artifactId: "a_kbd" });
  });

  // X10 — rail row click carries the comment's anchor key so App.tsx can
  // scroll the artifact to the exact line / step / finding instead of just
  // selecting the artifact card.
  it("X10: clicking a line-anchored comment dispatches the line anchorKey", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a_x10", { title: "Findings" }));
    s.addComment(comment({
      id: "c_line", artifactId: "a_x10", author: "human",
      content: "this line worries me",
      createdAt: "2026-04-26T10:00:00.000Z",
      target: { lineStart: 42, filePath: "src/auth.ts", findingIndex: 1, evidenceIndex: 0 },
    }));

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<ConversationRail onClose={() => {}} />);
    await userEvent.click(screen.getByText("this line worries me"));
    const focus = dispatchSpy.mock.calls
      .map((c) => c[0] as CustomEvent)
      .find((e) => e.type === "dp:focus-artifact");
    expect((focus as any).detail).toEqual({
      artifactId: "a_x10",
      anchorKey: "line:src/auth.ts:42",
    });
  });

  it("X10: clicking a step-anchored comment dispatches the step anchorKey", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a_step", { title: "Plan", type: "plan" }));
    s.addComment(comment({
      id: "c_step", artifactId: "a_step", author: "human",
      content: "step 3 is risky",
      createdAt: "2026-04-26T10:00:00.000Z",
      target: { stepIndex: 2 },
    }));

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<ConversationRail onClose={() => {}} />);
    await userEvent.click(screen.getByText("step 3 is risky"));
    const focus = dispatchSpy.mock.calls
      .map((c) => c[0] as CustomEvent)
      .find((e) => e.type === "dp:focus-artifact");
    expect((focus as any).detail).toEqual({
      artifactId: "a_step",
      anchorKey: "step:2",
    });
  });

  it("X10: clicking an artifact-level comment dispatches with no anchorKey", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a_root", { title: "Notes" }));
    s.addComment(comment({
      id: "c_root", artifactId: "a_root", author: "human",
      content: "general thought",
      createdAt: "2026-04-26T10:00:00.000Z",
      // No line / step / finding — just an artifact-root comment.
    }));

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<ConversationRail onClose={() => {}} />);
    await userEvent.click(screen.getByText("general thought"));
    const focus = dispatchSpy.mock.calls
      .map((c) => c[0] as CustomEvent)
      .find((e) => e.type === "dp:focus-artifact");
    expect((focus as any).detail.artifactId).toBe("a_root");
    expect((focus as any).detail.anchorKey).toBeUndefined();
  });

  it("renders a target label using filename + line range when present", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    s.addComment(comment({
      id: "c1", artifactId: "a1", author: "human", content: "x",
      createdAt: "2026-04-26T10:00:00.000Z",
      target: { lineStart: 23, lineEnd: 27, filePath: "src/auth/handlers.ts" },
    }));
    render(<ConversationRail onClose={() => {}} />);
    expect(screen.getByText(/handlers\.ts L23–L27/)).toBeInTheDocument();
  });

  it("Esc closes the drawer", async () => {
    const onClose = vi.fn();
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    render(<ConversationRail onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("counts every comment + reply in the header", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a2"));
    s.addComment(comment({ id: "c1", artifactId: "a1", author: "human", content: "x", createdAt: "2026-04-26T10:00:00.000Z" }));
    s.addComment(comment({ id: "c2", artifactId: "a1", author: "agent", parentCommentId: "c1", content: "y", createdAt: "2026-04-26T10:01:00.000Z" }));
    s.addComment(comment({ id: "c3", artifactId: "a2", author: "human", content: "z", createdAt: "2026-04-26T10:02:00.000Z" }));
    render(<ConversationRail onClose={() => {}} />);
    // 3 messages across 2 artifacts.
    expect(screen.getByText(/3 messages across 2 artifacts/i)).toBeInTheDocument();
  });
});

describe("ConversationRail — W2 (filter, unread badges)", () => {
  it("Unanswered filter pill collapses the list to just unanswered questions", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    s.addArtifact(artifact("a2", { title: "Plan" }));
    // a1: question + answer (answered)
    s.addComment(comment({ id: "q_done", artifactId: "a1", author: "human", intent: "question", content: "answered Q", createdAt: "2026-04-26T10:00:00.000Z" }));
    s.addComment(comment({ id: "ans", artifactId: "a1", author: "agent", parentCommentId: "q_done", content: "the answer", createdAt: "2026-04-26T10:01:00.000Z" }));
    // a1: regular comment (no question)
    s.addComment(comment({ id: "c_regular", artifactId: "a1", author: "human", content: "just a comment", createdAt: "2026-04-26T10:02:00.000Z" }));
    // a2: unanswered question
    s.addComment(comment({ id: "q_open", artifactId: "a2", author: "human", intent: "question", content: "still waiting", createdAt: "2026-04-26T10:03:00.000Z" }));

    render(<ConversationRail onClose={() => {}} />);
    // All filter shows everything.
    expect(screen.getByText("answered Q")).toBeInTheDocument();
    expect(screen.getByText("just a comment")).toBeInTheDocument();
    expect(screen.getByText("still waiting")).toBeInTheDocument();

    // Switch to Unanswered.
    await userEvent.click(screen.getByRole("button", { name: /unanswered/i }));
    expect(screen.queryByText("answered Q")).not.toBeInTheDocument();
    expect(screen.queryByText("just a comment")).not.toBeInTheDocument();
    expect(screen.getByText("still waiting")).toBeInTheDocument();

    // Group with no matches drops out: the "Findings" group is gone, only "Plan" remains.
    expect(screen.queryByText("Findings")).not.toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("U5 — a question answered via answer_question (answeredByCommentId, no reply) is excluded from BOTH the pill count and the filtered list", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    s.addArtifact(artifact("a2", { title: "Plan" }));
    // answered out-of-band: answeredByCommentId set, but NO threaded reply.
    // Pre-U5 the COUNT excluded this (correct) but the FILTER didn't, so the
    // pill read 1 while two rows showed — count and list disagreed.
    s.addComment({
      ...comment({ id: "q_answered", artifactId: "a1", author: "human", intent: "question", content: "answered out of band", createdAt: "2026-04-26T10:00:00.000Z" }),
      answeredByCommentId: "ans_x",
    });
    s.addComment(comment({ id: "q_open", artifactId: "a2", author: "human", intent: "question", content: "still waiting", createdAt: "2026-04-26T10:03:00.000Z" }));

    render(<ConversationRail onClose={() => {}} />);
    // pill counts only the genuinely-open question...
    expect(screen.getByText(/1 unanswered question/i)).toBeInTheDocument();
    // ...and the filtered list agrees — the answered one does not leak in.
    await userEvent.click(screen.getByRole("button", { name: /unanswered/i }));
    expect(screen.queryByText("answered out of band")).not.toBeInTheDocument();
    expect(screen.getByText("still waiting")).toBeInTheDocument();
  });

  it("Unanswered filter empty-state when there are no open questions", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addComment(comment({ id: "c1", artifactId: "a1", author: "human", content: "regular", createdAt: "2026-04-26T10:00:00.000Z" }));
    render(<ConversationRail onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /unanswered/i }));
    expect(screen.getByText(/no unanswered questions/i)).toBeInTheDocument();
  });

  it("Filter pills show counts (All N · Unanswered K)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addComment(comment({ id: "c1", artifactId: "a1", author: "human", content: "x", createdAt: "2026-04-26T10:00:00.000Z" }));
    s.addComment(comment({ id: "c2", artifactId: "a1", author: "human", intent: "question", content: "y", createdAt: "2026-04-26T10:01:00.000Z" }));
    render(<ConversationRail onClose={() => {}} />);
    const allBtn = screen.getByRole("button", { name: /^All\b/i });
    const unanBtn = screen.getByRole("button", { name: /^Unanswered\b/i });
    expect(allBtn.textContent).toMatch(/2/);
    expect(unanBtn.textContent).toMatch(/1/);
  });

  it("first-ever open: every comment counts as unread (last-opened defaults to 0)", () => {
    sessionStorage.removeItem("dp:rail-last-opened-at");
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addComment(comment({ id: "c1", artifactId: "a1", author: "human", content: "first comment ever", createdAt: "2026-04-26T10:00:00.000Z" }));
    render(<ConversationRail onClose={() => {}} />);
    // Header total-unread badge = 1
    expect(screen.getByLabelText(/1 new since last open/i)).toBeInTheDocument();
    // Per-comment unread dot
    expect(screen.getAllByLabelText(/new since last open/i).length).toBeGreaterThan(0);
  });

  it("re-opening after close: only comments newer than the last-open time are marked unread", () => {
    // Simulate: rail was opened at t=10:30 (so anything before is read).
    const lastOpened = new Date("2026-04-26T10:30:00.000Z").getTime();
    sessionStorage.setItem("dp:rail-last-opened-at", String(lastOpened));

    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addComment(comment({ id: "c_old", artifactId: "a1", author: "human", content: "before", createdAt: "2026-04-26T10:00:00.000Z" }));
    s.addComment(comment({ id: "c_new", artifactId: "a1", author: "agent", content: "after", createdAt: "2026-04-26T11:00:00.000Z" }));
    render(<ConversationRail onClose={() => {}} />);
    // One unread: the agent comment from after the last-open time.
    expect(screen.getByLabelText(/1 new since last open/i)).toBeInTheDocument();
  });

  it("opening the rail updates sessionStorage to now (so the next open's diff is fresh)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addComment(comment({ id: "c1", artifactId: "a1", author: "human", content: "x", createdAt: "2026-04-26T10:00:00.000Z" }));
    const before = Date.now();
    render(<ConversationRail onClose={() => {}} />);
    const persisted = Number(sessionStorage.getItem("dp:rail-last-opened-at") ?? "0");
    expect(persisted).toBeGreaterThanOrEqual(before);
  });

  it("Reply — every thread with an agent presence shows a Reply affordance", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    s.addComment(comment({
      id: "q1", artifactId: "a1", author: "human", intent: "question",
      content: "why bcrypt 4 rounds?", createdAt: "2026-04-26T10:00:00.000Z",
    }));
    s.addComment(comment({
      id: "ans1", artifactId: "a1", author: "agent", parentCommentId: "q1",
      content: "copy-paste error", createdAt: "2026-04-26T10:01:00.000Z",
    }));
    render(<ConversationRail onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /reply in this thread/i })).toBeInTheDocument();
  });

  it("Reply — threads with NO agent presence (human-only) don't show Reply (nothing to continue yet)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    s.addComment(comment({
      id: "h1", artifactId: "a1", author: "human", content: "just a thought", createdAt: "2026-04-26T10:00:00.000Z",
    }));
    render(<ConversationRail onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /reply in this thread/i })).not.toBeInTheDocument();
  });

  it("Reply — submit posts a comment with parentCommentId pointing at the latest agent reply", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    s.addComment(comment({
      id: "q1", artifactId: "a1", author: "human", intent: "question",
      content: "Q", createdAt: "2026-04-26T10:00:00.000Z",
      target: { lineStart: 5 },
    }));
    s.addComment(comment({
      id: "ans1", artifactId: "a1", author: "agent", parentCommentId: "q1",
      content: "A", createdAt: "2026-04-26T10:01:00.000Z",
      target: { lineStart: 5 },
    }));

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ comment: { id: "h_followup" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ConversationRail onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /reply in this thread/i }));
    const textarea = screen.getByPlaceholderText(/continue the thread/i);
    await userEvent.type(textarea, "follow-up question");
    const submitBtns = screen.getAllByRole("button", { name: /^Reply$/ });
    await userEvent.click(submitBtns[submitBtns.length - 1]);

    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toBe("follow-up question");
    // Parent is the latest agent reply (ans1), not the original human Q.
    expect(body.parentCommentId).toBe("ans1");
    // Inherits the parent's line anchor.
    expect(body.target.lineStart).toBe(5);
  });

  it("artifact group header shows a per-group unread count when fresh comments exist there", () => {
    sessionStorage.removeItem("dp:rail-last-opened-at");
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Hot artifact" }));
    s.addComment(comment({ id: "c1", artifactId: "a1", author: "human", content: "x", createdAt: "2026-04-26T10:00:00.000Z" }));
    s.addComment(comment({ id: "c2", artifactId: "a1", author: "agent", content: "y", createdAt: "2026-04-26T10:01:00.000Z" }));
    render(<ConversationRail onClose={() => {}} />);
    // Per-group pip: aria-label is exactly "{n} new" (no "since last open").
    expect(screen.getByLabelText(/^2 new$/)).toBeInTheDocument();
    // Header total-unread badge has the longer label and shows up too.
    expect(screen.getByLabelText(/2 new since last open/i)).toBeInTheDocument();
  });
});
