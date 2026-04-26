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
import { render, screen } from "@testing-library/react";
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
    // The threaded reply has the ↳ indicator.
    expect(screen.getByText(/↳/)).toBeInTheDocument();
  });

  it("flags an unanswered human question with the awaiting-reply marker", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Findings" }));
    s.addComment(comment({
      id: "q1", artifactId: "a1", author: "human", intent: "question",
      content: "is this the same issue as #14?", createdAt: "2026-04-26T10:00:00.000Z",
    }));
    render(<ConversationRail onClose={() => {}} />);
    expect(screen.getByText(/awaiting agent answer/i)).toBeInTheDocument();
    expect(screen.getByText(/1 unanswered question/i)).toBeInTheDocument();
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
    expect(screen.queryByText(/awaiting agent answer/i)).not.toBeInTheDocument();
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
