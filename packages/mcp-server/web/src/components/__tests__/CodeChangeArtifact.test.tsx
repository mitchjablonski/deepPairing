import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useArtifactStore } from "../../stores/artifact";
import { CodeChangeArtifact } from "../artifacts/CodeChangeArtifact";

// Shiki is async; stub it so the result/CommentableCode view renders the
// plain-text fallback synchronously. We only assert on interactions + targets.
vi.mock("../../hooks/useHighlightedCode", () => ({
  useHighlightedCode: () => ({ lines: null }),
}));

/**
 * Frontend `before`-reconstruction. Agents routinely ship a re-edit as
 * changeType="create" with an empty `before`, which would otherwise render as
 * a full-file dump under a misleading "create" banner. The component looks for
 * a prior code_change on the same file in the loaded session and uses its
 * `after` as the synthetic `before`. Belt-and-suspenders with the backend
 * reconstruction, which only takes effect after an MCP restart and can't heal
 * already-stored artifacts.
 */
const mkArt = (overrides: any) =>
  ({
    id: "a",
    type: "code_change",
    title: "x",
    status: "draft",
    version: 1,
    createdAt: "2026-05-31T00:00:00.000Z",
    content: {},
    ...overrides,
  }) as any;

describe("CodeChangeArtifact — frontend reconstruction of `before`", () => {
  beforeEach(() => {
    useArtifactStore.getState().reset();
  });

  it("reclassifies a mislabeled 'create' and reconstructs the diff from a prior same-file code_change", () => {
    // a1: the agent shipped the file's initial content (genuine create).
    useArtifactStore.getState().addArtifact(
      mkArt({
        id: "a1",
        content: {
          filePath: "foo.ts",
          changeType: "create",
          before: "",
          after: "line1\nline2\nline3",
          reasoning: "initial",
        },
        createdAt: "2026-05-31T00:00:00.000Z",
      }),
    );
    // a2: the agent edits foo.ts but (wrongly) labels it 'create' again with no before.
    const a2 = mkArt({
      id: "a2",
      content: {
        filePath: "foo.ts",
        changeType: "create",
        before: "",
        after: "line1\nCHANGED\nline3",
        reasoning: "tweak line 2",
      },
      createdAt: "2026-05-31T00:00:30.000Z",
    });

    render(<CodeChangeArtifact artifact={a2} />);

    // Banner pill is corrected from "create" to "modify" since we synthesized a before.
    expect(screen.getByText("modify")).toBeInTheDocument();
    // The visible "diff reconstructed" hint tells the user this isn't from the artifact's own data.
    expect(screen.getByText("diff reconstructed")).toBeInTheDocument();
    // The changed line appears in the rendered diff.
    expect(screen.getByText("CHANGED")).toBeInTheDocument();
  });

  it("leaves a genuine first creation as 'create' with no badge and no diff reconstruction", () => {
    const a1 = mkArt({
      id: "a1",
      content: {
        filePath: "newfile.ts",
        changeType: "create",
        before: "",
        after: "hello\nworld",
        reasoning: "new file",
      },
      createdAt: "2026-05-31T00:00:00.000Z",
    });

    render(<CodeChangeArtifact artifact={a1} />);

    expect(screen.getByText("create")).toBeInTheDocument();
    expect(screen.queryByText("diff reconstructed")).not.toBeInTheDocument();
  });

  it("split view (default) renders Before/After column headers", () => {
    useArtifactStore.getState().addArtifact(
      mkArt({
        id: "a1",
        content: { filePath: "foo.ts", changeType: "create", before: "", after: "hello", reasoning: "init" },
        createdAt: "2026-05-31T00:00:00.000Z",
      }),
    );
    const a2 = mkArt({
      id: "a2",
      content: { filePath: "foo.ts", changeType: "create", before: "", after: "hi", reasoning: "tweak" },
      createdAt: "2026-05-31T00:00:30.000Z",
    });

    render(<CodeChangeArtifact artifact={a2} />);

    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("pairs a removed/added run side-by-side (old line on the left, new on the right)", () => {
    useArtifactStore.getState().addArtifact(
      mkArt({
        id: "a1",
        content: { filePath: "foo.ts", changeType: "create", before: "", after: "OLD_VALUE", reasoning: "init" },
        createdAt: "2026-05-31T00:00:00.000Z",
      }),
    );
    const a2 = mkArt({
      id: "a2",
      content: { filePath: "foo.ts", changeType: "create", before: "", after: "NEW_VALUE", reasoning: "tweak" },
      createdAt: "2026-05-31T00:00:30.000Z",
    });

    render(<CodeChangeArtifact artifact={a2} />);

    // Both halves of the paired removed/added row render.
    expect(screen.getByText("OLD_VALUE")).toBeInTheDocument();
    expect(screen.getByText("NEW_VALUE")).toBeInTheDocument();
  });

  it("does NOT use a later same-file artifact as the prior (createdAt ordering)", () => {
    // A later artifact in the store mustn't become a "prior" for an earlier one.
    useArtifactStore.getState().addArtifact(
      mkArt({
        id: "future",
        content: {
          filePath: "foo.ts",
          changeType: "modify",
          before: "irrelevant",
          after: "irrelevant",
          reasoning: "future",
        },
        createdAt: "2026-05-31T00:10:00.000Z",
      }),
    );
    const earlier = mkArt({
      id: "earlier",
      content: {
        filePath: "foo.ts",
        changeType: "create",
        before: "",
        after: "hello",
        reasoning: "earlier",
      },
      createdAt: "2026-05-31T00:00:00.000Z",
    });

    render(<CodeChangeArtifact artifact={earlier} />);

    // Stays a "create" — no earlier prior exists; the later one mustn't be used.
    expect(screen.getByText("create")).toBeInTheDocument();
    expect(screen.queryByText("diff reconstructed")).not.toBeInTheDocument();
  });
});

/**
 * Inline commenting on the diff views (split + unified). Before this, a user
 * could comment in the "result" view but not while looking at a diff, and
 * agent replies — which inherit the parent comment's line target — never
 * rendered on the diff rows. The diff rows now share CommentableCode's
 * per-line gutter / composer / threading via the LineComments component, so a
 * comment made from a diff row targets the SAME new-side line and threads
 * identically.
 */
describe("CodeChangeArtifact — inline comments on the diff views", () => {
  beforeEach(() => {
    useArtifactStore.getState().reset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  // A two-line change: line 1 unchanged, line 2 changed (OLD → NEW).
  // new-side line numbers: 1 (unchanged), 2 (added "NEW").
  const mkChange = (id: string, after: string) =>
    mkArt({
      id,
      content: { filePath: "auth.ts", changeType: "modify", before: "keep\nOLD", after, reasoning: "r" },
      createdAt: "2026-05-31T00:00:00.000Z",
    });

  it("a comment submitted from the SPLIT diff view targets the correct new-side line", async () => {
    render(<CodeChangeArtifact artifact={mkChange("a", "keep\nNEW")} />);
    // Split is the default view. The added "NEW" line is new-side line 2.
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    // Click the last gutter + button (the changed/added line, new-side L2).
    await userEvent.click(commentBtns[commentBtns.length - 1]);
    const input = screen.getByPlaceholderText(/add a comment on this line/i);
    await userEvent.type(input, "rename this var");
    const submitBtns = screen.getAllByRole("button", { name: /^Comment$/ });
    await userEvent.click(submitBtns[submitBtns.length - 1]);

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.content).toBe("rename this var");
    expect(body.target.lineStart).toBe(2);
    expect(body.target.lineEnd).toBe(2); // single-line target, matches result view
    expect(body.target.filePath).toBe("auth.ts");
  });

  it("a comment submitted from the UNIFIED diff view targets the correct new-side line", async () => {
    render(<CodeChangeArtifact artifact={mkChange("a", "keep\nNEW")} />);
    // Switch to the unified view.
    await userEvent.click(screen.getByRole("button", { name: /^Unified$/ }));
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    // The added row (new-side L2) is the last commentable row; the removed
    // row ("OLD") has no new-side line and no comment button.
    await userEvent.click(commentBtns[commentBtns.length - 1]);
    const input = screen.getByPlaceholderText(/add a comment on this line/i);
    await userEvent.type(input, "why NEW?");
    const submitBtns = screen.getAllByRole("button", { name: /^Comment$/ });
    await userEvent.click(submitBtns[submitBtns.length - 1]);

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.target.lineStart).toBe(2);
    expect(body.target.lineEnd).toBe(2);
  });

  it("the removed line in the unified view offers NO comment button (no new-side anchor)", async () => {
    render(<CodeChangeArtifact artifact={mkChange("a", "keep\nNEW")} />);
    await userEvent.click(screen.getByRole("button", { name: /^Unified$/ }));
    // Rows with a new-side line: unchanged "keep" (L1) + added "NEW" (L2) = 2
    // gutters. The removed "OLD" row gets none.
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    expect(commentBtns).toHaveLength(2);
  });

  it("existing line comments + their agent replies render inline on the SPLIT diff rows", () => {
    const userQ = {
      id: "q1",
      sessionId: "s",
      target: { artifactId: "a", lineStart: 2, lineEnd: 2 },
      parentCommentId: null,
      author: "human" as const,
      content: "is NEW safe?",
      acknowledged: false,
      createdAt: "2026-05-31T00:01:00.000Z",
      intent: "question" as const,
    };
    const agentA = {
      id: "ans1",
      sessionId: "s",
      target: { artifactId: "a", lineStart: 2, lineEnd: 2 },
      parentCommentId: "q1",
      author: "agent" as const,
      content: "yes, NEW is validated upstream",
      acknowledged: true,
      createdAt: "2026-05-31T00:02:00.000Z",
    };
    useArtifactStore.getState().addComment(userQ as any);
    useArtifactStore.getState().addComment(agentA as any);

    render(<CodeChangeArtifact artifact={mkChange("a", "keep\nNEW")} />);

    // Both the question and the threaded agent reply render on the diff row.
    expect(screen.getByText(/is NEW safe/)).toBeInTheDocument();
    expect(screen.getByText(/validated upstream/)).toBeInTheDocument();
    // The agent reply is threaded (↳ marker present).
    expect(screen.getAllByText("↳").length).toBeGreaterThanOrEqual(1);
  });

  it("existing line comments render inline on the UNIFIED diff rows too", async () => {
    const c = {
      id: "c1",
      sessionId: "s",
      target: { artifactId: "a", lineStart: 2, lineEnd: 2 },
      parentCommentId: null,
      author: "human" as const,
      content: "tighten this",
      acknowledged: false,
      createdAt: "2026-05-31T00:01:00.000Z",
    };
    useArtifactStore.getState().addComment(c as any);
    render(<CodeChangeArtifact artifact={mkChange("a", "keep\nNEW")} />);
    await userEvent.click(screen.getByRole("button", { name: /^Unified$/ }));
    expect(screen.getByText(/tighten this/)).toBeInTheDocument();
  });

  it("the result view (CommentableCode) still comments on the same new-side line, unchanged", async () => {
    render(<CodeChangeArtifact artifact={mkChange("a", "keep\nNEW")} />);
    await userEvent.click(screen.getByRole("button", { name: /^Result$/ }));
    // Result view shows the full after-text; line 2 is "NEW".
    const commentBtns = screen.getAllByRole("button", { name: /add a comment on this line/i });
    expect(commentBtns).toHaveLength(2); // both lines commentable in the result view
    await userEvent.click(commentBtns[1]); // line 2
    const input = screen.getByPlaceholderText(/add a comment on this line/i);
    await userEvent.type(input, "from result view");
    const submitBtns = screen.getAllByRole("button", { name: /^Comment$/ });
    await userEvent.click(submitBtns[submitBtns.length - 1]);

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.target.lineStart).toBe(2);
    expect(body.target.lineEnd).toBe(2);
    expect(body.target.filePath).toBe("auth.ts");
  });
});
