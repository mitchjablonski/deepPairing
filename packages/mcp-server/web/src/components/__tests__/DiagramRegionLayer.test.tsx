import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MermaidDiagram } from "../MermaidDiagram";
import { useArtifactStore } from "../../stores/artifact";

// Mermaid needs real layout, so mock it: we hand back an SVG string carrying
// real `g.node` elements so the region layer can enumerate + hit-test them.
const renderMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderMock } }));

const TWO_NODE_SVG =
  "<svg aria-label='diagram'>" +
  "<g class='node' id='flowchart-AuthGate-1'><text>AuthGate</text></g>" +
  "<g class='node' id='flowchart-Login-2'><text>Login</text></g>" +
  "</svg>";

function addRegionComment(over: { id: string; content: string; region: Record<string, unknown> }) {
  useArtifactStore.getState().addComment({
    id: over.id,
    sessionId: "s",
    target: { artifactId: "a", visualId: "vis_1", region: over.region },
    parentCommentId: null,
    author: "human",
    content: over.content,
    acknowledged: false,
    createdAt: "2026-06-18T00:00:00.000Z",
  } as any);
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  renderMock.mockReset();
  renderMock.mockResolvedValue({ svg: TWO_NODE_SVG });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comment: null }) }));
});

describe("DiagramRegionLayer (region-anchored diagram comments)", () => {
  it("does NOT mount the drag affordance on a read-only diagram (no region prop)", async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(screen.queryByTestId("dp-region-overlay")).not.toBeInTheDocument();
    expect(screen.queryByText(/comment on a node/i)).not.toBeInTheDocument();
  });

  it("mounts the drag overlay + a per-node keyboard affordance on the interactive diagram", async () => {
    render(<MermaidDiagram source="graph TD; A-->B" region={{ artifactId: "a", visualId: "vis_1" }} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(screen.getByTestId("dp-region-overlay")).toBeInTheDocument();
    expect(screen.getByText(/comment on a node/i)).toBeInTheDocument();
  });

  it("KEYBOARD PATH: activating a node's button (via Enter, no mouse) opens a composer targeting that node", async () => {
    const user = userEvent.setup();
    render(<MermaidDiagram source="graph TD; AuthGate-->Login" region={{ artifactId: "a", visualId: "vis_1" }} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());

    // Reveal the node list (disclosure), then drive the button purely by keyboard.
    await user.click(screen.getByText(/comment on a node/i));
    const authBtn = screen.getByRole("button", { name: "AuthGate" });
    authBtn.focus();
    expect(authBtn).toHaveFocus();
    await user.keyboard("{Enter}");

    // Composer opened, anchored to the focused node by LABEL (textual anchor).
    expect(screen.getByText(/Commenting on \[AuthGate\]/)).toBeInTheDocument();

    // Type + send through the SAME composer/submit path as every comment.
    const box = screen.getByPlaceholderText(/add a comment/i);
    await user.type(box, "rename this box");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((fetch as any).mock.calls.at(-1)[1].body);
    expect(body.target.region.labels).toEqual(["AuthGate"]);
    expect(body.target.region.elementIds).toEqual(["flowchart-AuthGate-1"]);
    expect(body.target.visualId).toBe("vis_1");
  });

  it("renders an EXISTING region comment back onto the diagram (highlight + text referent)", async () => {
    addRegionComment({
      id: "rc1",
      content: "split this",
      region: { x: 0.1, y: 0.1, w: 0.3, h: 0.2, elementIds: ["flowchart-AuthGate-1"], labels: ["AuthGate"] },
    });
    render(<MermaidDiagram source="graph TD; AuthGate-->Login" region={{ artifactId: "a", visualId: "vis_1" }} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(screen.getByTestId("dp-region-highlight")).toBeInTheDocument();
    expect(screen.getByText(/on region \[AuthGate\]/)).toBeInTheDocument();
  });

  it("DEGRADATION: a region comment whose node was removed by a revision still renders, flagged 'node gone' (no crash)", async () => {
    addRegionComment({
      id: "rc_ghost",
      content: "was here",
      region: { x: 0.1, y: 0.1, w: 0.3, h: 0.2, elementIds: ["flowchart-Ghost-9"], labels: ["Ghost"] },
    });
    // Current diagram has AuthGate + Login but NOT Ghost.
    render(<MermaidDiagram source="graph TD; AuthGate-->Login" region={{ artifactId: "a", visualId: "vis_1" }} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    // The comment did NOT vanish…
    expect(screen.getByText(/on region \[Ghost\]/)).toBeInTheDocument();
    // …and it's honest that the node is gone.
    expect(screen.getAllByText(/node no longer in this diagram/i).length).toBeGreaterThan(0);
    const hl = screen.getByTestId("dp-region-highlight");
    expect(hl).toHaveAttribute("data-region-missing", "true");
  });

  it("DEGRADATION: when the SVG fails to render (source fallback), no drag affordance appears but region comments still show as text", async () => {
    addRegionComment({
      id: "rc_fb",
      content: "note on the gate",
      region: { x: 0, y: 0, w: 0.5, h: 0.5, elementIds: ["flowchart-AuthGate-1"], labels: ["AuthGate"] },
    });
    // Blank source hits the fuzzy-safe fallback (mermaid never invoked).
    render(<MermaidDiagram source="   " region={{ artifactId: "a", visualId: "vis_1" }} />);
    await waitFor(() => expect(screen.getByText(/Couldn.t render this diagram/i)).toBeInTheDocument());
    expect(screen.queryByTestId("dp-region-overlay")).not.toBeInTheDocument();
    expect(screen.queryByText(/comment on a node/i)).not.toBeInTheDocument();
    // The human's earlier region comment is still legible as text.
    expect(screen.getByText(/on region \[AuthGate\] — note on the gate/)).toBeInTheDocument();
  });
});
