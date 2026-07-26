import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MermaidDiagram } from "../MermaidDiagram";
import { useArtifactStore } from "../../stores/artifact";

/** #185 — deterministic matchMedia: `narrow` drives useIsNarrowViewport
 *  (max-width:900px) so a test can force the popover vs legacy-block choice;
 *  prefers-reduced-motion defaults off. happy-dom's own matchMedia returns
 *  matches:false, but stubbing removes cross-test flakiness. */
function mockMatchMedia(narrow = false) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width") ? narrow : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

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
  mockMatchMedia(false); // default: wide viewport → popover composer
});

afterEach(() => {
  vi.useRealTimers();
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

  // --- #185 popover composer + reverse navigation ---------------------------
  describe("#185 popover composer at the selection", () => {
    async function mountInteractive() {
      render(<MermaidDiagram source="graph TD; AuthGate-->Login" region={{ artifactId: "a", visualId: "vis_1" }} />);
      await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
      return screen.getByTestId("dp-region-overlay");
    }
    function completeDrag(overlay: HTMLElement) {
      fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 200, clientY: 150 });
      fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 200, clientY: 150 });
    }

    it("a completed drag opens the composer as an anchored POPOVER, not the below-diagram block", async () => {
      const overlay = await mountInteractive();
      completeDrag(overlay);
      const popover = await screen.findByTestId("dp-region-popover");
      expect(popover).toBeInTheDocument();
      // Anchored, not the legacy below-diagram block.
      expect(screen.queryByTestId("dp-region-composer-block")).not.toBeInTheDocument();
      // Absolutely positioned within the well, carrying its computed placement
      // (geometry variety — below/above/beside/clamp — is proven in the pure
      // positionPopover matrix; happy-dom returns all-zero rects, so here it's
      // the default below placement at the origin).
      expect(popover.className).toContain("absolute");
      expect(popover).toHaveAttribute("data-placement");
      // The same CommentThread composer, so the note flows through unchanged.
      expect(screen.getByText(/Commenting on/)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
    });

    it("focuses the composer's textarea with preventScroll (no yank when the region is offscreen)", async () => {
      const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
      const overlay = await mountInteractive();
      completeDrag(overlay);
      await screen.findByTestId("dp-region-popover");
      // The open-composer focus contract now passes { preventScroll: true } — the
      // exact fix for the field-reported yank (focusing the old below-block
      // scrolled a large diagram to the bottom, away from the selection).
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
      focusSpy.mockRestore();
    });

    it("Esc cancels the composer and restores focus to its trigger (contract unregressed)", async () => {
      const user = userEvent.setup();
      render(<MermaidDiagram source="graph TD; AuthGate-->Login" region={{ artifactId: "a", visualId: "vis_1" }} />);
      await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
      // Open via the keyboard node path so there's a real trigger to restore to.
      await user.click(screen.getByText(/comment on a node/i));
      const authBtn = screen.getByRole("button", { name: "AuthGate" });
      authBtn.focus();
      await user.keyboard("{Enter}");
      await screen.findByTestId("dp-region-popover");
      expect(screen.getByPlaceholderText(/add a comment/i)).toHaveFocus();
      // Esc from the focused textarea bubbles to the composer's onKeyDown and
      // cancels it (and, in a modal host, wouldn't also close the modal —
      // stopPropagation), restoring focus to the trigger.
      await user.keyboard("{Escape}");
      expect(screen.queryByTestId("dp-region-popover")).not.toBeInTheDocument();
      expect(authBtn).toHaveFocus();
    });

    it("SMALL-VIEWPORT fallback: a narrow width degrades to the legacy below-diagram block, not a cramped popover", async () => {
      mockMatchMedia(true); // narrow → useIsNarrowViewport true
      const overlay = await mountInteractive();
      completeDrag(overlay);
      const block = await screen.findByTestId("dp-region-composer-block");
      expect(block).toBeInTheDocument();
      // No popover — the block is the legacy in-flow placement.
      expect(screen.queryByTestId("dp-region-popover")).not.toBeInTheDocument();
      expect(block.className).toContain("mt-2");
      // Same composer inside.
      expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
    });
  });

  describe("#185 reverse navigation from a posted region thread", () => {
    function seedRegion() {
      addRegionComment({
        id: "rc_nav",
        content: "tighten this",
        region: { x: 0.1, y: 0.1, w: 0.3, h: 0.2, elementIds: ["dp-mmd-1-2-flowchart-AuthGate-0"], labels: ["AuthGate"] },
      });
    }
    async function mountWithComment() {
      seedRegion();
      render(<MermaidDiagram source="graph TD; AuthGate-->Login" region={{ artifactId: "a", visualId: "vis_1" }} />);
      await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    }

    it("clicking a thread anchor scrolls its region into view and flash-highlights it, then clears the flash", async () => {
      await mountWithComment();
      const highlight = screen.getByTestId("dp-region-highlight");
      const scrollSpy = vi.fn();
      // scrollIntoView?.() — the optional chain skips it in happy-dom (no layout
      // engine), so give the element a real method to observe.
      (highlight as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy;

      vi.useFakeTimers();
      const anchor = screen.getByTestId("dp-region-thread-anchor");
      fireEvent.click(anchor);

      // Scrolled the RIGHT element to center, smooth (reduced-motion off here).
      expect(scrollSpy).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
      // Flash applied to the region rect.
      expect(highlight).toHaveAttribute("data-region-flash", "true");
      expect(highlight.className).toContain("dp-region-flash");

      // The pulse clears after its timeout (nothing lingers).
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(highlight).toHaveAttribute("data-region-flash", "false");
      expect(highlight.className).not.toContain("dp-region-flash");
    });

    it("KEYBOARD: activating the anchor by Enter navigates too — passing the COMMENT, never an event (#187)", async () => {
      await mountWithComment();
      const highlight = screen.getByTestId("dp-region-highlight");
      const scrollSpy = vi.fn();
      (highlight as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy;

      const anchor = screen.getByTestId("dp-region-thread-anchor");
      anchor.focus();
      expect(anchor).toHaveFocus();
      // Enter on the focused button activates onClick — the handler is invoked
      // with the comment payload (arrow wrapper), never the KeyboardEvent, so
      // the flash lands on THIS comment's rect (proving the payload identity).
      await userEvent.keyboard("{Enter}");
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(highlight).toHaveAttribute("data-region-flash", "true");
    });
  });

  // --- #185 FEEL ROUND: roomy popover · draggable · click-region-to-reopen ---
  //
  // The four approved behaviors (live-iterated + screenshot-verified on the
  // branch) plus the focus-after-send fix found during verification. happy-dom
  // returns all-zero rects, so geometry-dependent behaviors (loose bounds, the
  // click hit-test, distinct regions for the reset) mock getBoundingClientRect
  // for the diagram SVG (its box) and the well (the overlay's ancestor); the
  // rest ride the pure clamp/offset math, which is screen-honest without layout.
  describe("#185 feel round", () => {
    afterEach(() => {
      // Restore the getBoundingClientRect / focus spies these tests install
      // (vitest has no restoreMocks here; the matchMedia stub is untouched).
      vi.restoreAllMocks();
    });

    async function mountInteractive(opts?: { narrow?: boolean; optionId?: string }) {
      if (opts?.narrow) mockMatchMedia(true);
      const region = { artifactId: "a", visualId: "vis_1", ...(opts?.optionId ? { optionId: opts.optionId } : {}) };
      const utils = render(<MermaidDiagram source="graph TD; AuthGate-->Login" region={region} />);
      await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
      return { overlay: screen.getByTestId("dp-region-overlay"), ...utils };
    }
    function completeDrag(overlay: HTMLElement, from = { x: 10, y: 10 }, to = { x: 200, y: 150 }) {
      fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: from.x, clientY: from.y });
      fireEvent.pointerMove(overlay, { pointerId: 1, clientX: to.x, clientY: to.y });
      fireEvent.pointerUp(overlay, { pointerId: 1, clientX: to.x, clientY: to.y });
    }
    // A CLICK (sub-4px) on the overlay — exercises finishDrag's isClickDrag arm.
    function clickAt(overlay: HTMLElement, x: number, y: number) {
      fireEvent.pointerDown(overlay, { button: 0, pointerId: 2, clientX: x, clientY: y });
      fireEvent.pointerUp(overlay, { pointerId: 2, clientX: x + 1, clientY: y });
    }
    // Non-zero rects for the diagram SVG (== its box) and the well (any ancestor
    // of the overlay). Everything else stays zero — so the overlay's own rect is
    // {0,0} and click coords map straight to well-local px.
    function mockGeometry(W: number, H: number) {
      const rect = (w: number, h: number) =>
        ({ x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON() {} }) as DOMRect;
      return vi
        .spyOn(Element.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: Element) {
          if (this.getAttribute?.("aria-label") === "diagram") return rect(W, H);
          if (this.querySelector?.('[data-testid="dp-region-overlay"]')) return rect(W, H);
          return rect(0, 0);
        });
    }
    function addRegion(
      id: string,
      region: Record<string, unknown>,
      optionId?: string,
      opts?: { author?: "human" | "agent"; createdAt?: string },
    ) {
      useArtifactStore.getState().addComment({
        id,
        sessionId: "s",
        target: { artifactId: "a", visualId: "vis_1", region, ...(optionId ? { optionId } : {}) },
        parentCommentId: null,
        author: opts?.author ?? "human",
        content: `c-${id}`,
        acknowledged: false,
        createdAt: opts?.createdAt ?? "2026-06-18T00:00:00.000Z",
      } as any);
    }
    const DRAG_HANDLE = "Drag to move this comment box";

    // --- Behavior 1: roomy popover -----------------------------------------
    it("ROOMY: the popover is 400px wide and its CommentThread is roomy (rows=4)", async () => {
      const { overlay } = await mountInteractive();
      completeDrag(overlay);
      const popover = await screen.findByTestId("dp-region-popover");
      // POPOVER_WIDTH 288→400 (well width is 0 in happy-dom, so the clamp keeps
      // the fixed 400, not the well).
      expect(popover.style.width).toBe("400px");
      // The region CommentThread now gets `roomy` → a 4-row auto-growing composer.
      expect(screen.getByPlaceholderText(/add a comment/i)).toHaveAttribute("rows", "4");
    });

    it("ROOMY: the narrow-viewport fallback composer is ALSO roomy (shared renderComposerInner)", async () => {
      const { overlay } = await mountInteractive({ narrow: true });
      completeDrag(overlay);
      await screen.findByTestId("dp-region-composer-block");
      expect(screen.queryByTestId("dp-region-popover")).not.toBeInTheDocument();
      // roomy is passed by BOTH placements (they share renderComposerInner).
      expect(screen.getByPlaceholderText(/add a comment/i)).toHaveAttribute("rows", "4");
    });

    // --- Behavior 2: draggable by header -----------------------------------
    it("DRAGGABLE: a pointerdown→move→up sequence on the header moves the popover", async () => {
      const { overlay } = await mountInteractive();
      completeDrag(overlay);
      const popover = await screen.findByTestId("dp-region-popover");
      const handle = screen.getByTitle(DRAG_HANDLE);
      expect(popover.style.top).toBe("0px");
      // Drag the header down 40px → dragOffset.dy=40 → the popover follows.
      fireEvent.pointerDown(handle, { pointerId: 5, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(handle, { pointerId: 5, clientX: 0, clientY: 40 , buttons: 1 });
      fireEvent.pointerUp(handle, { pointerId: 5, clientX: 0, clientY: 40 });
      expect(popover.style.top).toBe("40px");
    });

    it("DRAGGABLE: clicking Cancel never starts a drag (its pointerdown stops propagation)", async () => {
      const { overlay } = await mountInteractive();
      completeDrag(overlay);
      const popover = await screen.findByTestId("dp-region-popover");
      const handle = screen.getByTitle(DRAG_HANDLE);
      const cancel = screen.getByRole("button", { name: /cancel region comment/i });
      // pointerdown lands on Cancel (stops propagation, so the header never
      // captures a drag-start); a subsequent header move must NOT move the box.
      fireEvent.pointerDown(cancel, { pointerId: 6, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(handle, { pointerId: 6, clientX: 0, clientY: 80 , buttons: 1 });
      expect(popover.style.top).toBe("0px");
    });

    it("DRAGGABLE: the narrow-fallback header is NOT a drag handle (pointer-only affordance stays off)", async () => {
      const { overlay } = await mountInteractive({ narrow: true });
      completeDrag(overlay);
      await screen.findByTestId("dp-region-composer-block");
      expect(screen.queryByTitle(DRAG_HANDLE)).not.toBeInTheDocument();
      // No grab cursor / drag styling on the fallback header either.
      expect(document.querySelector(".cursor-grab")).toBeNull();
    });

    it("DRAGGABLE: selecting a NEW region RESETS the drag offset (each selection re-anchors)", async () => {
      mockGeometry(800, 600); // distinct regions need a real SVG box
      const A_FROM = { x: 100, y: 100 };
      const A_TO = { x: 300, y: 300 };
      const B_FROM = { x: 400, y: 60 };
      const B_TO = { x: 560, y: 160 };

      // Phase 1: open A, DRAG the popover, then select a DIFFERENT region B.
      const p1 = await mountInteractive();
      completeDrag(p1.overlay, A_FROM, A_TO);
      await screen.findByTestId("dp-region-popover");
      const handle = screen.getByTitle(DRAG_HANDLE);
      fireEvent.pointerDown(handle, { pointerId: 7, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(handle, { pointerId: 7, clientX: 0, clientY: 200 , buttons: 1 });
      const movedTop = screen.getByTestId("dp-region-popover").style.top;
      completeDrag(p1.overlay, B_FROM, B_TO);
      const bAfterDrag = screen.getByTestId("dp-region-popover").style.top;
      p1.unmount();

      // Phase 2: open A then B with NO drag between — the clean baseline for B.
      const p2 = await mountInteractive();
      completeDrag(p2.overlay, A_FROM, A_TO);
      await screen.findByTestId("dp-region-popover");
      completeDrag(p2.overlay, B_FROM, B_TO);
      const bClean = screen.getByTestId("dp-region-popover").style.top;

      // The Phase-1 drag must NOT have leaked into B's placement (offset reset).
      expect(bAfterDrag).toBe(bClean);
      // …and the drag genuinely moved the box (guards a vacuous test).
      expect(movedTop).not.toBe(bClean);
    });

    // --- Behavior 3: loose drag bounds (short well) ------------------------
    it("LOOSE BOUNDS: a SHORT well lets the box be pulled BELOW the well (top can exceed wellHeight)", async () => {
      mockGeometry(800, 120); // short well: an in-well clamp would collapse dy to ~0
      const { overlay } = await mountInteractive();
      completeDrag(overlay);
      const popover = await screen.findByTestId("dp-region-popover");
      const handle = screen.getByTitle(DRAG_HANDLE);
      // Pull the header far DOWN. New bound: top ≤ wellHeight + 320.
      fireEvent.pointerDown(handle, { pointerId: 8, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(handle, { pointerId: 8, clientX: 0, clientY: 5000 , buttons: 1 });
      // top saturates at wellHeight(120) + DRAG_BELOW(320) = 440 — well BELOW the
      // 120px-tall well (the whole point of the loosened bound).
      expect(popover.style.top).toBe("440px");
      expect(parseFloat(popover.style.top)).toBeGreaterThan(120);
    });

    it("LOOSE BOUNDS: horizontal overhang stops with ≥64px of the box still reachable", async () => {
      mockGeometry(800, 120);
      const { overlay } = await mountInteractive();
      completeDrag(overlay);
      const popover = await screen.findByTestId("dp-region-popover");
      const handle = screen.getByTitle(DRAG_HANDLE);
      // Far LEFT: left ≥ -(width-64) = -(400-64) = -336 → 64px of the 400px box
      // still pokes past x=0 into the well.
      fireEvent.pointerDown(handle, { pointerId: 9, clientX: 1000, clientY: 1000 });
      fireEvent.pointerMove(handle, { pointerId: 9, clientX: -5000, clientY: 1000 , buttons: 1 });
      expect(popover.style.left).toBe("-336px");
      expect(-336 + 400).toBeGreaterThanOrEqual(64);
      // Far RIGHT: left ≤ wellWidth-64 = 800-64 = 736 → 64px still inside the well.
      fireEvent.pointerDown(handle, { pointerId: 9, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(handle, { pointerId: 9, clientX: 12000, clientY: 0 , buttons: 1 });
      expect(popover.style.left).toBe("736px");
      expect(800 - 736).toBeGreaterThanOrEqual(64);
    });

    // --- Behavior 4: click a posted region highlight → reopen its thread ----
    it("CLICK-TO-REOPEN: clicking inside a posted region re-opens that region's thread", async () => {
      mockGeometry(800, 600);
      // region covers well-local x∈[80,240], y∈[90,210].
      addRegion("rc_hit", { x: 0.1, y: 0.15, w: 0.2, h: 0.2, labels: ["Target"] });
      const { overlay } = await mountInteractive();
      expect(screen.queryByText(/Commenting on/)).not.toBeInTheDocument();
      clickAt(overlay, 150, 130); // inside the region
      expect(screen.getByText(/Commenting on \[Target\]/)).toBeInTheDocument();
    });

    it("CLICK-TO-REOPEN: clicking EMPTY well space opens nothing", async () => {
      mockGeometry(800, 600);
      addRegion("rc_hit", { x: 0.1, y: 0.15, w: 0.2, h: 0.2, labels: ["Target"] });
      const { overlay } = await mountInteractive();
      clickAt(overlay, 10, 10); // outside the region
      expect(screen.queryByText(/Commenting on/)).not.toBeInTheDocument();
      expect(screen.queryByTestId("dp-region-popover")).not.toBeInTheDocument();
    });

    it("CLICK-TO-REOPEN: with overlapping regions, the SMALLEST containing region wins", async () => {
      mockGeometry(800, 600);
      // Outer covers x[40,440] y[30,330]; Inner covers x[80,160] y[60,120].
      addRegion("rc_outer", { x: 0.05, y: 0.05, w: 0.5, h: 0.5, labels: ["Outer"] });
      addRegion("rc_inner", { x: 0.1, y: 0.1, w: 0.1, h: 0.1, labels: ["Inner"] });
      const { overlay } = await mountInteractive();
      clickAt(overlay, 120, 90); // inside BOTH — smallest (Inner) must win
      expect(screen.getByText(/Commenting on \[Inner\]/)).toBeInTheDocument();
      expect(screen.queryByText(/Commenting on \[Outer\]/)).not.toBeInTheDocument();
    });

    it("CLICK-TO-REOPEN: the hit-test cannot cross OPTIONS — another option's region opens nothing (#173)", async () => {
      mockGeometry(800, 600);
      // A posted region that belongs to a DIFFERENT decision option.
      addRegion("rc_other_opt", { x: 0.1, y: 0.15, w: 0.2, h: 0.2, labels: ["Other"] }, "opt_2");
      // This layer is scoped to opt_1 → regionComments excludes opt_2's comment,
      // so the hit-test can't even see it (no highlight, nothing to reopen).
      const { overlay } = await mountInteractive({ optionId: "opt_1" });
      expect(screen.queryByTestId("dp-region-highlight")).not.toBeInTheDocument();
      clickAt(overlay, 150, 130); // dead-center of the OTHER option's rect
      expect(screen.queryByText(/Commenting on/)).not.toBeInTheDocument();
    });

    // --- Fix: focus-after-send dead zone -----------------------------------
    it("FOCUS-AFTER-SEND: sending from the popover returns focus to the composer, so Escape still closes it", async () => {
      const user = userEvent.setup();
      const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
      const { overlay } = await mountInteractive();
      completeDrag(overlay);
      await screen.findByTestId("dp-region-popover");
      const box = screen.getByPlaceholderText(/add a comment/i);
      await user.type(box, "needs a retry");
      const callsBeforeSend = focusSpy.mock.calls.length;
      await user.keyboard("{Meta>}{Enter}{/Meta}"); // send through the shared path
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      // The dead-zone fix: after the send lands (a provisional comment appears
      // for the active region) focus is pulled back to the composer's textarea,
      // with the same preventScroll contract as the open-focus effect.
      await waitFor(() => expect(focusSpy.mock.calls.length).toBeGreaterThan(callsBeforeSend));
      expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
      // With focus back inside the popover, Escape reaches the composer's
      // onKeyDown and closes it (the layered-Esc contract) instead of hitting
      // <body> and doing nothing.
      await user.keyboard("{Escape}");
      expect(screen.queryByTestId("dp-region-popover")).not.toBeInTheDocument();
    });

    // --- Fix (review): focus-after-send must not STEAL focus -----------------
    // The active region for a zero-geometry drag is the label-less {0,0,0,0}
    // rect, so a comment posted on that same rect threads onto it (sameRegion).
    const ACTIVE_REGION = { x: 0, y: 0, w: 0, h: 0 };

    async function openPopoverThenAddComment() {
      const { overlay } = await mountInteractive();
      completeDrag(overlay);
      await screen.findByTestId("dp-region-popover");
      return overlay;
    }

    it("FOCUS-STEAL GUARD: an AGENT reply growing the active region's thread never steals focus from a sibling field", async () => {
      await openPopoverThenAddComment();
      // The human has clicked into another field and is typing there.
      const sibling = document.createElement("input");
      document.body.appendChild(sibling);
      sibling.focus();
      expect(sibling).toHaveFocus();
      // An agent reply arrives over WS — it inherits the parent's region target
      // (answer-question), so it passes the regionComments filter + grows the
      // count. Focus must NOT be yanked into the popover.
      act(() =>
        addRegion("rc_agent_reply", ACTIVE_REGION, undefined, {
          author: "agent",
          createdAt: "2026-06-19T00:00:00.000Z",
        }),
      );
      expect(sibling).toHaveFocus();
      sibling.remove();
    });

    it("FOCUS-STEAL GUARD: a HUMAN comment landing while the user has moved to another field does not steal focus back", async () => {
      await openPopoverThenAddComment();
      const sibling = document.createElement("input");
      document.body.appendChild(sibling);
      sibling.focus();
      expect(sibling).toHaveFocus();
      // Even a HUMAN-authored growth must not reclaim focus the user has since
      // moved elsewhere (activeElement is neither <body> nor inside the popover).
      act(() =>
        addRegion("rc_human_late", ACTIVE_REGION, undefined, {
          author: "human",
          createdAt: "2026-06-19T00:00:00.000Z",
        }),
      );
      expect(sibling).toHaveFocus();
      sibling.remove();
    });

    it("FOCUS-STEAL GUARD: a HUMAN comment landing while focus fell to <body> DOES reclaim the composer (original fix, still pinned)", async () => {
      await openPopoverThenAddComment();
      const box = screen.getByPlaceholderText(/add a comment/i);
      // The send's disabled-textarea blur drops focus to <body>.
      box.blur();
      expect(box).not.toHaveFocus();
      act(() =>
        addRegion("rc_human_send", ACTIVE_REGION, undefined, {
          author: "human",
          createdAt: "2026-06-19T00:00:00.000Z",
        }),
      );
      // Focus was LOST by the send, so reclaiming it is correct.
      expect(box).toHaveFocus();
    });

    // --- Fix (review): an interrupted drag must not make the popover chase ----
    it("DRAG INTERRUPTION: a pointercancel aborts the drag so a later stray HOVER does not move the popover", async () => {
      const { overlay } = await mountInteractive();
      completeDrag(overlay);
      const popover = await screen.findByTestId("dp-region-popover");
      const handle = screen.getByTitle(DRAG_HANDLE);
      expect(popover.style.top).toBe("0px");
      fireEvent.pointerDown(handle, { pointerId: 11, clientX: 0, clientY: 0 });
      // The browser reclaims the pointer mid-drag (OS gesture / pen takeover)…
      fireEvent.pointerCancel(handle, { pointerId: 11 });
      // …then a stray HOVER over the header (no button held) must NOT resume the
      // drag from the interrupted start.
      fireEvent.pointerMove(handle, { pointerId: 11, clientX: 0, clientY: 300, buttons: 0 });
      expect(popover.style.top).toBe("0px");
    });

    it("DRAG INTERRUPTION: a plain hover (no button held) over the header never moves the popover (buttons guard)", async () => {
      const { overlay } = await mountInteractive();
      completeDrag(overlay);
      const popover = await screen.findByTestId("dp-region-popover");
      const handle = screen.getByTitle(DRAG_HANDLE);
      fireEvent.pointerDown(handle, { pointerId: 12, clientX: 0, clientY: 0 });
      // buttons===0 → a hover, not a drag: the belt heals the stale start.
      fireEvent.pointerMove(handle, { pointerId: 12, clientX: 0, clientY: 250, buttons: 0 });
      expect(popover.style.top).toBe("0px");
    });

    it("DRAG INTERRUPTION: a normal button-held drag (buttons=1) still moves the popover", async () => {
      const { overlay } = await mountInteractive();
      completeDrag(overlay);
      const popover = await screen.findByTestId("dp-region-popover");
      const handle = screen.getByTitle(DRAG_HANDLE);
      fireEvent.pointerDown(handle, { pointerId: 13, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(handle, { pointerId: 13, clientX: 0, clientY: 90, buttons: 1 });
      expect(popover.style.top).toBe("90px");
    });
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
