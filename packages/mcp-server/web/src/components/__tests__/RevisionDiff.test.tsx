import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { RevisionDiff } from "../RevisionDiff";
import { useArtifactStore } from "../../stores/artifact";

// Diagram side-by-side renders MermaidDiagram (lazy mermaid) — mock it.
const renderMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderMock } }));

beforeEach(() => {
  useArtifactStore.getState().reset();
  renderMock.mockReset();
  renderMock.mockResolvedValue({ svg: "<svg aria-label='d'></svg>" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

function mkArtifact(over: Partial<Artifact>): Artifact {
  return {
    id: "x",
    type: "plan",
    title: "Plan",
    version: 1,
    parentId: null,
    status: "draft",
    content: {},
    createdAt: "2026-06-20T00:00:00.000Z",
    ...over,
  } as Artifact;
}

describe("RevisionDiff", () => {
  it("renders nothing when the artifact has no parent in the store (not a revision)", () => {
    const a = mkArtifact({ id: "a1" });
    const { container } = render(<RevisionDiff artifact={a} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a 'what changed' toggle, the revise reason, and a file_map SEMANTIC diff", () => {
    const v1 = mkArtifact({
      id: "v1",
      version: 1,
      content: {
        steps: [],
        estimatedChanges: 1,
        visuals: [
          {
            id: "files",
            kind: "file_map",
            title: "Files",
            files: [
              { path: "a.ts", change: "create" },
              { path: "poller.ts", change: "delete" },
              { path: "db.ts", change: "create" },
            ],
          },
        ],
      },
    });
    const v2 = mkArtifact({
      id: "v2",
      version: 2,
      parentId: "v1",
      agentReasoning: "keep the poller behind a flag",
      content: {
        steps: [],
        estimatedChanges: 1,
        visuals: [
          {
            id: "files",
            kind: "file_map",
            title: "Files",
            files: [
              { path: "a.ts", change: "modify" }, // changed create→modify
              { path: "db.ts", change: "create" }, // unchanged
              { path: "cache.ts", change: "create" }, // added
            ],
          },
        ],
      },
    });
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2);

    render(<RevisionDiff artifact={v2} />);

    expect(screen.getByText(/keep the poller behind a flag/)).toBeInTheDocument();
    expect(screen.getByText("cache.ts")).toBeInTheDocument(); // added
    expect(screen.getByText("poller.ts")).toBeInTheDocument(); // removed
    expect(screen.getByText("a.ts")).toBeInTheDocument(); // changed
    expect(screen.getByText(/create→modify/)).toBeInTheDocument();
    // db.ts is unchanged → not surfaced
    expect(screen.queryByText("db.ts")).not.toBeInTheDocument();
  });

  it("renders a changed diagram side-by-side (Before + After)", () => {
    const v1 = mkArtifact({
      id: "d1",
      version: 1,
      content: { steps: [], estimatedChanges: 0, visuals: [{ id: "arch", kind: "diagram", title: "Arch", source: "graph TD; A-->B" }] },
    });
    const v2 = mkArtifact({
      id: "d2",
      version: 2,
      parentId: "d1",
      content: { steps: [], estimatedChanges: 0, visuals: [{ id: "arch", kind: "diagram", title: "Arch", source: "graph TD; A-->B-->C" }] },
    });
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2);

    render(<RevisionDiff artifact={v2} />);
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("U1 — a changed prototype shows a 'changed' notification (not two identical previews, not a Run button)", () => {
    const v1 = mkArtifact({ id: "p1", version: 1, content: { steps: [], estimatedChanges: 0, visuals: [{ id: "proto", kind: "prototype", title: "Mock", html: "<button>a</button>" }] } });
    const v2 = mkArtifact({ id: "p2", version: 2, parentId: "p1", content: { steps: [], estimatedChanges: 0, visuals: [{ id: "proto", kind: "prototype", title: "Mock", html: "<button>b</button>" }] } });
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2);

    render(<RevisionDiff artifact={v2} />);
    expect(screen.queryByRole("button", { name: /run prototype/i })).not.toBeInTheDocument();
    expect(screen.getByText("changed")).toBeInTheDocument(); // the "it changed" signal
    expect(screen.getByText(/open the live version/i)).toBeInTheDocument();
  });

  it("marks an unchanged visual as unchanged (no noisy before/after)", () => {
    const visuals = [{ id: "arch", kind: "diagram" as const, title: "Arch", source: "graph TD; A-->B" }];
    const v1 = mkArtifact({ id: "u1", version: 1, content: { steps: [], estimatedChanges: 0, visuals } });
    const v2 = mkArtifact({ id: "u2", version: 2, parentId: "u1", content: { steps: [], estimatedChanges: 0, visuals } });
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2);

    render(<RevisionDiff artifact={v2} />);
    expect(screen.getByText("unchanged")).toBeInTheDocument();
    expect(screen.queryByText("Before")).not.toBeInTheDocument();
  });

  it("diffs plan STEPS in the body (added / changed / removed)", () => {
    const v1 = mkArtifact({
      id: "p1",
      version: 1,
      content: {
        estimatedChanges: 1,
        steps: [
          { description: "Add WS gateway", reasoning: "push" },
          { description: "Drop the poller", reasoning: "obsolete" },
        ],
      },
    });
    const v2 = mkArtifact({
      id: "p2",
      version: 2,
      parentId: "p1",
      content: {
        estimatedChanges: 2,
        steps: [
          { description: "Add WS gateway", reasoning: "push via worker" }, // changed (reasoning)
          { description: "Add unread cache", reasoning: "fast counts" }, // added
        ],
      },
    });
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2);

    render(<RevisionDiff artifact={v2} />);
    expect(screen.getByText("Steps")).toBeInTheDocument();
    expect(screen.getByText("Add unread cache")).toBeInTheDocument(); // added
    expect(screen.getByText("Drop the poller")).toBeInTheDocument(); // removed
    expect(screen.getByText("Add WS gateway")).toBeInTheDocument(); // changed (matched by description)
  });

  it("diffs DECISION options in the body (the other revisable artifact)", () => {
    const v1 = mkArtifact({
      id: "d1",
      type: "decision",
      version: 1,
      content: {
        context: "pick a store",
        decisionId: "store",
        options: [
          { id: "a", title: "Postgres", description: "relational", pros: [], cons: [], recommendation: true },
          { id: "b", title: "Mongo", description: "document", pros: [], cons: [], recommendation: false },
        ],
      },
    });
    const v2 = mkArtifact({
      id: "d2",
      type: "decision",
      version: 2,
      parentId: "d1",
      content: {
        context: "pick a store",
        decisionId: "store",
        options: [
          { id: "a", title: "Postgres", description: "relational + JSONB", pros: [], cons: [], recommendation: true }, // changed
          { id: "c", title: "SQLite", description: "embedded", pros: [], cons: [], recommendation: false }, // added
        ],
      },
    });
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2);

    render(<RevisionDiff artifact={v2} />);
    expect(screen.getByText("Options")).toBeInTheDocument();
    expect(screen.getByText("SQLite")).toBeInTheDocument(); // added
    expect(screen.getByText("Mongo")).toBeInTheDocument(); // removed
    expect(screen.getByText("Postgres")).toBeInTheDocument(); // changed (matched by id)
  });
});
