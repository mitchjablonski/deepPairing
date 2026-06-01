import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useArtifactStore } from "../../stores/artifact";
import { CodeChangeArtifact } from "../artifacts/CodeChangeArtifact";

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
