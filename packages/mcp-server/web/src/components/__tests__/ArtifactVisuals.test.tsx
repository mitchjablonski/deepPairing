import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { PlanVisual } from "@deeppairing/shared";
import { ArtifactVisuals } from "../ArtifactVisuals";
import { useArtifactStore } from "../../stores/artifact";

// Diagrams render through MermaidDiagram (lazy-imports mermaid); mock it so the
// SVG path is deterministic in happy-dom.
const renderMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderMock } }));

beforeEach(() => {
  useArtifactStore.getState().reset();
  renderMock.mockReset();
  renderMock.mockResolvedValue({ svg: "<svg aria-label='diagram'><text>arch</text></svg>" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("ArtifactVisuals", () => {
  it("renders nothing when there are no visuals", () => {
    const { container } = render(<ArtifactVisuals artifactId="a" visuals={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a file_map as a directory tree with a change summary + per-visual comment affordance", () => {
    render(
      <ArtifactVisuals
        artifactId="a"
        visuals={[
          {
            id: "fm",
            kind: "file_map",
            title: "What I'll touch",
            files: [
              { path: "src/api/routes.ts", change: "create", note: "new route" },
              { path: "src/api/handlers.ts", change: "create" },
              { path: "src/db.ts", change: "modify" },
              { path: "old.ts", change: "delete" },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText("Visuals (1)")).toBeInTheDocument();
    expect(screen.getByText("What I'll touch")).toBeInTheDocument();
    expect(screen.getByText("src/")).toBeInTheDocument();
    expect(screen.getByText("api/")).toBeInTheDocument();
    expect(screen.getByText("routes.ts")).toBeInTheDocument();
    expect(screen.getByText("handlers.ts")).toBeInTheDocument();
    expect(screen.getByText("db.ts")).toBeInTheDocument();
    expect(screen.getByText("old.ts")).toBeInTheDocument();
    expect(screen.getByText("+2 new")).toBeInTheDocument();
    expect(screen.getByText("~1 changed")).toBeInTheDocument();
    expect(screen.getByText("−1 removed")).toBeInTheDocument();
    expect(screen.getByText(/new route/)).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("renders a prototype as a click-to-run sandboxed frame (html not injected into the page)", () => {
    render(<ArtifactVisuals artifactId="a" visuals={[{ id: "p", kind: "prototype", html: "<button>hi</button>" }]} />);
    expect(screen.getByText(/sandboxed . no network/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run prototype/i })).toBeInTheDocument();
    expect(screen.queryByText("hi")).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("renders a diagram visual to SVG (kind='diagram')", async () => {
    render(<ArtifactVisuals artifactId="a" visuals={[{ id: "d", kind: "diagram", title: "Arch", source: "graph TD; A-->B" }]} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(screen.getByText("Arch")).toBeInTheDocument();
  });

  it("renders MIXED kinds together, each its own commentable block", async () => {
    render(
      <ArtifactVisuals
        artifactId="a"
        visuals={[
          { id: "d", kind: "diagram", title: "Flow", source: "sequenceDiagram; A->>B: hi" },
          { id: "fm", kind: "file_map", title: "Files", files: [{ path: "a.ts", change: "create" }] },
          { id: "p", kind: "prototype", title: "Mock", html: "<div>x</div>" },
        ]}
      />,
    );
    expect(screen.getByText("Visuals (3)")).toBeInTheDocument();
    expect(screen.getByText("Flow")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Mock")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    // each block is anchored for comments
    expect(document.querySelectorAll('[data-comment-anchor^="visual:"]').length).toBe(3);
  });

  it("reflects a stored comment's count on the matching visual's trigger", () => {
    useArtifactStore.getState().addComment({
      id: "c1",
      sessionId: "s",
      target: { artifactId: "a", visualId: "fm" } as any,
      parentCommentId: null,
      author: "human",
      content: "rename this",
      acknowledged: false,
      createdAt: "2026-06-18T00:00:00.000Z",
    } as any);
    render(<ArtifactVisuals artifactId="a" visuals={[{ id: "fm", kind: "file_map", files: [{ path: "a.ts" }] }]} />);
    // The comment count surfaces on the block (CommentTrigger badge).
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("surfaces a labelled, kind-aware comment call-to-action on each visual (not just a top-right icon)", () => {
    render(
      <ArtifactVisuals
        artifactId="a"
        visuals={[
          { id: "d", kind: "diagram", source: "graph TD; A-->B" },
          { id: "fm", kind: "file_map", files: [{ path: "a.ts" }] },
          { id: "p", kind: "prototype", html: "<i>x</i>" },
        ]}
      />,
    );
    // The discoverable affordance is labelled per kind, so it's obvious what
    // clicking does — unlike the old bare 💬 icon.
    expect(screen.getByText("Comment on this diagram")).toBeInTheDocument();
    expect(screen.getByText("Comment on this file map")).toBeInTheDocument();
    expect(screen.getByText("Comment on this prototype")).toBeInTheDocument();
  });

  it("renders an annotated_code visual: real code + the agent's line annotations, numbered from lineStart", () => {
    const { container } = render(
      <ArtifactVisuals
        artifactId="a"
        visuals={[
          {
            id: "ac",
            kind: "annotated_code",
            title: "The change",
            code: "const x = 1;\nreturn x;",
            filePath: "src/x.ts",
            lineStart: 40,
            annotations: [{ line: 40, note: "declare the value", kind: "add" }],
          },
        ]}
      />,
    );
    expect(screen.getByText("The change")).toBeInTheDocument();
    expect(screen.getByText("Comment on this code")).toBeInTheDocument(); // kind-aware CTA
    expect(screen.getByText("declare the value")).toBeInTheDocument(); // agent annotation rendered
    expect(screen.getByText("40")).toBeInTheDocument(); // gutter numbered from lineStart
    expect(container.textContent).toContain("return x;"); // code body present
  });

  it("annotated_code without code degrades to a notice (no crash)", () => {
    render(<ArtifactVisuals artifactId="a" visuals={[{ id: "ac", kind: "annotated_code" }]} />);
    expect(screen.getByText(/No code provided/i)).toBeInTheDocument();
  });

  describe("adversarial / partial visuals never crash", () => {
    const cases: Array<[string, PlanVisual]> = [
      ["empty diagram source", { id: "d", kind: "diagram", source: "" }],
      ["file_map with no files", { id: "f", kind: "file_map", files: [] }],
      ["prototype with empty html", { id: "p", kind: "prototype", html: "" }],
      ["unknown kind", { id: "u", kind: "weird" as any }],
      ["file with no change (defaults)", { id: "f2", kind: "file_map", files: [{ path: "root.ts" }] }],
      ["deeply nested path", { id: "f3", kind: "file_map", files: [{ path: "a/b/c/d/e.ts", change: "create" }] }],
      ["annotated_code with bad annotations", { id: "ac", kind: "annotated_code", code: "x", annotations: "nope" as any }],
      ["annotated_code with non-string code", { id: "ac2", kind: "annotated_code", code: 42 as any }],
    ];
    for (const [name, visual] of cases) {
      it(name, () => {
        expect(() => render(<ArtifactVisuals artifactId="a" visuals={[visual]} />)).not.toThrow();
      });
    }

    it("a wholly malformed visuals array (wrong-typed fields) doesn't throw", () => {
      const junk = [
        { id: "x", kind: "file_map", files: "not-an-array" },
        { id: "y", kind: "diagram", source: 42 },
        { id: "z", kind: "prototype", html: null },
      ] as unknown as PlanVisual[];
      expect(() => render(<ArtifactVisuals artifactId="a" visuals={junk} />)).not.toThrow();
    });
  });
});
