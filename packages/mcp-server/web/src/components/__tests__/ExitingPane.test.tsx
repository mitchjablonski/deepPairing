import { createRef } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { PresenceContext } from "motion/react";
import type { Artifact } from "@deeppairing/shared";
import { ArtifactDetail, ArtifactPane } from "../ArtifactPanel";
import { useArtifactStore } from "../../stores/artifact";

/**
 * #623 — after you pick another artifact, AnimatePresence keeps the previous
 * pane mounted while it animates out. That pane must not be operable (Tab onto
 * its Approve, Enter approves the artifact you left), and focus inside it must
 * land in the entering pane, not <body>.
 *
 * AnimatePresence tells an exiting subtree through PresenceContext; the
 * provider below gives the leaving pane the value it sees in that window. An
 * unknown artifact type keeps the render synchronous (no lazy renderer).
 */
const pane = (id: string) =>
  ({
    id,
    sessionId: "s1",
    type: "hologram",
    title: `Synthetic pane ${id}`,
    status: "draft",
    version: 1,
    parentId: null,
    agentReasoning: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    content: { summary: "Synthetic" },
  }) as unknown as Artifact;

const presence = (isPresent: boolean) => ({ id: "one", isPresent, register: () => () => {}, initial: false as const });

function panes(onePresent: boolean) {
  return (
    <>
      <PresenceContext.Provider value={presence(onePresent)}>
        <ArtifactPane artifact={pane("one")}><ArtifactDetail artifact={pane("one")} /></ArtifactPane>
      </PresenceContext.Provider>
      <ArtifactPane artifact={pane("two")}><ArtifactDetail artifact={pane("two")} /></ArtifactPane>
    </>
  );
}

const paneEl = (id: string) => document.querySelector<HTMLElement>(`[data-dp-pane][data-artifact-id="${id}"]`)!;

beforeEach(() => {
  useArtifactStore.getState().reset();
});

describe("#623 — an exiting artifact pane is not operable", () => {
  it("the leaving pane is inert and the entering pane is not", () => {
    useArtifactStore.setState({ selectedArtifactId: "two" });
    const { rerender } = render(panes(true));
    expect(paneEl("one")).not.toHaveAttribute("inert");
    rerender(panes(false));
    expect(paneEl("one")).toHaveAttribute("inert");
    expect(paneEl("two")).not.toHaveAttribute("inert");
    expect(document.querySelectorAll("[data-dp-pane]")).toHaveLength(2);
  });

  it("focus inside the leaving pane moves to the entering pane, not <body>", () => {
    useArtifactStore.setState({ selectedArtifactId: "two" });
    const { rerender } = render(panes(true));
    // A stand-in for the leaving pane's Approve: any control that held focus.
    const control = paneEl("one").appendChild(document.createElement("button"));
    control.focus();
    expect(document.activeElement).toBe(control);
    rerender(panes(false));
    expect(document.activeElement).toBe(paneEl("two"));
  });

  it("control: focus outside the leaving pane stays where it is", () => {
    useArtifactStore.setState({ selectedArtifactId: "two" });
    const outside = document.body.appendChild(document.createElement("button"));
    outside.focus();
    const { rerender } = render(panes(true));
    rerender(panes(false));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("control: a pane outside AnimatePresence is never inert", () => {
    render(<ArtifactPane artifact={pane("solo")}><ArtifactDetail artifact={pane("solo")} /></ArtifactPane>);
    expect(paneEl("solo")).not.toHaveAttribute("inert");
  });
  it("forwards the popLayout DOM ref and keeps error fallback inside the same pane identity", () => {
    const ref = createRef<HTMLDivElement>();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never { throw new Error("Synthetic malformed renderer"); }
    try {
      const { rerender } = render(<ArtifactPane key="broken" ref={ref} artifact={pane("broken")}><ErrorBoundary fallback={<button>Recover</button>}><Broken /></ErrorBoundary></ArtifactPane>);
      expect(ref.current).toBe(paneEl("broken"));
      expect(paneEl("broken").querySelector("button")).toHaveTextContent("Recover");
      expect(document.querySelectorAll("[data-dp-pane]")).toHaveLength(1);
      rerender(<ArtifactPane key="healthy" artifact={pane("healthy")}><ErrorBoundary><ArtifactDetail artifact={pane("healthy")} /></ErrorBoundary></ArtifactPane>);
      expect(paneEl("healthy")).not.toHaveTextContent("Recover");
      expect(document.querySelector('[data-artifact-id="broken"]')).toBeNull();
    } finally { log.mockRestore(); }
  });

});
