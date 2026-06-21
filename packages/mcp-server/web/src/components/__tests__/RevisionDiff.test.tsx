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
});
