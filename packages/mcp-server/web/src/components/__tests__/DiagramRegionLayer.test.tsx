import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MermaidDiagram } from "../MermaidDiagram";
import { useArtifactStore } from "../../stores/artifact";

// Mermaid needs real layout, so mock it: we hand back an SVG string carrying
// real `g.node` elements so the region layer can enumerate + hit-test them.
const renderMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderMock } }));

// Real mermaid ids carry a per-render counter prefix (dp-mmd-N-M-…), so they
// differ every render — the tests must reflect that, not use stable fake ids.
const TWO_NODE_SVG =
  "<svg aria-label='diagram'>" +
  "<g class='node' id='dp-mmd-5-6-flowchart-AuthGate-0'><text>AuthGate</text></g>" +
  "<g class='node' id='dp-mmd-5-6-flowchart-Login-1'><text>Login</text></g>" +
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
    const overlay = screen.getByTestId("dp-region-overlay");
    expect(overlay).toBeInTheDocument();
    // Honest cursor: the ONE surface where dragging does something announces it.
    expect(overlay.className).toContain("cursor-crosshair");
    // Presentational — the keyboard path below is the accessible equivalent.
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(/comment on a node/i)).toBeInTheDocument();
  });

  it("the capture overlay spans the WHOLE well, not just the SVG box (gutter drags work)", async () => {
    // Field bug round 2: the well is flex-centered, so a narrow diagram has
    // wide gutters inside the visible border. When the overlay was sized to
    // the SVG box, those gutters LOOKED like capture zone but were dead —
    // "I can't select left of the login form". The overlay must be inset-0
    // (well-sized) with NO inline geometry pinning it to the SVG box;
    // normalizeRect clamps gutter-started drags to the diagram's edge.
    render(<MermaidDiagram source="graph TD; A-->B" region={{ artifactId: "a", visualId: "vis_1" }} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    const overlay = screen.getByTestId("dp-region-overlay");
    expect(overlay.className).toContain("inset-0");
    expect(overlay.style.left).toBe("");
    expect(overlay.style.width).toBe("");
  });

  // --- drag path (pointer capture — a stray drag must not end early) ---------
  //
  // Seam honesty: happy-dom's setPointerCapture is a stub — it does NOT
  // retarget subsequent events the way a real browser's capture does. So these
  // tests assert the two halves of the contract at the seam we CAN exercise:
  //  (1) pointerdown requests capture for its pointerId (spy), and
  //  (2) move/up events DELIVERED to the overlay — which is exactly how a
  //      captured pointer's events arrive in a real browser, wherever the
  //      pointer actually is — complete the drag even when their coordinates
  //      lie far outside the overlay's box, and pointerleave mid-drag no
  //      longer terminates the selection (the old element-bound mouse
  //      listeners finished the drag the moment the pointer crossed the edge).
  describe("drag selection", () => {
    async function mountInteractive() {
      render(<MermaidDiagram source="graph TD; AuthGate-->Login" region={{ artifactId: "a", visualId: "vis_1" }} />);
      await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
      return screen.getByTestId("dp-region-overlay");
    }

    it("captures the pointer on pointerdown, so the marquee survives leaving the diagram", async () => {
      const overlay = await mountInteractive();
      const capture = vi.spyOn(overlay, "setPointerCapture");
      fireEvent.pointerDown(overlay, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
      expect(capture).toHaveBeenCalledWith(7);
    });

    it("a drag whose move/up coordinates land OUTSIDE the overlay still completes a region (no early end)", async () => {
      const overlay = await mountInteractive();
      fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      // happy-dom rects are all-zero, so these coordinates are far outside the
      // overlay's box — pre-capture, a real pointer out here had already
      // stopped feeding the overlay events at all.
      fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 480, clientY: 260 });
      // Crossing the boundary mid-drag must NOT finish the selection…
      fireEvent.pointerLeave(overlay, { pointerId: 1, clientX: 480, clientY: 260 });
      expect(screen.queryByText(/Commenting on/)).not.toBeInTheDocument();
      // …the marquee is still live…
      expect(document.querySelector(".border-dashed")).not.toBeNull();
      // …and releasing OUTSIDE completes the region (rect clamps in-box).
      fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 520, clientY: 300 });
      expect(screen.getByText(/Commenting on/)).toBeInTheDocument();
    });

    it("a sub-4px pointer drag is still a click — no region composer", async () => {
      const overlay = await mountInteractive();
      fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 12, clientY: 11 });
      expect(screen.queryByText(/Commenting on/)).not.toBeInTheDocument();
    });

    it("pointercancel (browser reclaims the pointer) aborts the drag — no half-finished region", async () => {
      const overlay = await mountInteractive();
      fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 200, clientY: 150 });
      fireEvent.pointerCancel(overlay, { pointerId: 1 });
      expect(document.querySelector(".border-dashed")).toBeNull();
      fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 200, clientY: 150 });
      expect(screen.queryByText(/Commenting on/)).not.toBeInTheDocument();
    });
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

    // Focus MOVED into the composer (keyboard user isn't stranded on <body>).
    expect(screen.getByPlaceholderText(/add a comment/i)).toHaveFocus();

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((fetch as any).mock.calls.at(-1)[1].body);
    expect(body.target.region.labels).toEqual(["AuthGate"]);
    expect(body.target.region.elementIds).toEqual(["dp-mmd-5-6-flowchart-AuthGate-0"]);
    expect(body.target.visualId).toBe("vis_1");
  });

  it("Cancel restores focus to the node button that opened the composer (no focus dropped to body)", async () => {
    const user = userEvent.setup();
    render(<MermaidDiagram source="graph TD; AuthGate-->Login" region={{ artifactId: "a", visualId: "vis_1" }} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    await user.click(screen.getByText(/comment on a node/i));
    const authBtn = screen.getByRole("button", { name: "AuthGate" });
    authBtn.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByPlaceholderText(/add a comment/i)).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /cancel region comment/i }));
    expect(authBtn).toHaveFocus();
  });

  it("renders an EXISTING region comment back onto the diagram (highlight + text referent), NOT flagged missing across a re-render", async () => {
    // Stored under a DIFFERENT render prefix than the current SVG emits — the
    // node is the same (label AuthGate), so it must NOT be flagged missing.
    addRegionComment({
      id: "rc1",
      content: "split this",
      region: { x: 0.1, y: 0.1, w: 0.3, h: 0.2, elementIds: ["dp-mmd-1-2-flowchart-AuthGate-0"], labels: ["AuthGate"] },
    });
    render(<MermaidDiagram source="graph TD; AuthGate-->Login" region={{ artifactId: "a", visualId: "vis_1" }} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(screen.getByTestId("dp-region-highlight")).toBeInTheDocument();
    expect(screen.getByText(/on region \[AuthGate\]/)).toBeInTheDocument();
    // Crucially: the wolf-cry is NOT painted (label present despite new id).
    expect(screen.queryByText(/node no longer in this diagram/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("dp-region-highlight")).toHaveAttribute("data-region-missing", "false");
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
