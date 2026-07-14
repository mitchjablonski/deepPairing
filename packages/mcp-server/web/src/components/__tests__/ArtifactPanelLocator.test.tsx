import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import axe from "axe-core";
import { useArtifactStore } from "../../stores/artifact";
import { useReplayStore } from "../../stores/replay";
import { ArtifactPanel, buildFlowGroups } from "../ArtifactPanel";
import type { Artifact } from "@deeppairing/shared";

/**
 * New-item locator (#new-item-locator) — a live-arriving artifact card gets a
 * gentle glow (or a static ring under prefers-reduced-motion) and, when it's
 * off-viewport, an "off-screen pip" points the way. The arrival NEVER moves
 * scroll. These tests pin the correctness constraints that make the feature
 * safe: no load-glow, no scroll disturbance, replay suppression, and the a11y
 * contract (real button + polite announcement).
 */

const mk = (i: number, over: Partial<Artifact> = {}): Artifact =>
  ({
    id: `art_${i}`,
    sessionId: "s1",
    type: "research",
    title: `Artifact ${i}`,
    status: "draft",
    version: 1,
    parentId: null,
    content: { summary: "s", findings: [] },
    createdAt: `2026-06-01T00:${String(i).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-06-01T00:${String(i).padStart(2, "0")}:00.000Z`,
    ...over,
  }) as Artifact;

/** Deterministic matchMedia: only the reduced-motion query flips when asked. */
function stubMatchMedia(reduceMotion: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reduceMotion : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useReplayStore.getState().exitReplay();
  stubMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function glowNodes() {
  return document.querySelectorAll(".dp-arrival-glow");
}
function ringNodes() {
  return document.querySelectorAll(".dp-arrival-ring");
}

describe("ArtifactPanel new-item locator", () => {
  it("does NOT highlight anything on initial population (the load-glow failure mode)", () => {
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);
    // Every artifact is 'new' on first render — none may glow.
    expect(glowNodes().length).toBe(0);
    expect(ringNodes().length).toBe(0);
    // And the announcement region is empty.
    expect(screen.getByTestId("arrival-live-region").textContent).toBe("");
  });

  it("highlights a LIVE-added artifact and announces it politely", () => {
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);
    expect(glowNodes().length).toBe(0);

    act(() => {
      useArtifactStore.getState().addArtifact(mk(9, { title: "Fresh finding" }));
    });

    const newBtn = document.querySelector('[data-artifact-item="art_9"]');
    expect(newBtn).not.toBeNull();
    expect(newBtn!.className).toContain("dp-arrival-glow");
    // Only the newcomer glows, not the whole list.
    expect(glowNodes().length).toBe(1);
    // Polite announcement carries the title for screen-reader users.
    expect(screen.getByTestId("arrival-live-region").textContent).toBe(
      "New artifact: Fresh finding",
    );
  });

  it("clears the highlight after the timeout", () => {
    vi.useFakeTimers();
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);

    act(() => {
      useArtifactStore.getState().addArtifact(mk(9));
    });
    expect(glowNodes().length).toBe(1);

    act(() => {
      vi.advanceTimersByTime(4600);
    });
    expect(glowNodes().length).toBe(0);
  });

  it("does NOT write the sidebar scrollTop on arrival (scroll is sacred)", () => {
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);
    const scroller = screen.getByTestId("sidebar-scroll");

    // Track any write to scrollTop.
    let writes = 0;
    let value = 42; // pretend the user had scrolled
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => value,
      set: (v: number) => {
        writes++;
        value = v;
      },
    });

    act(() => {
      useArtifactStore.getState().addArtifact(mk(9));
    });

    // The arrival highlighted the card but never touched scroll position.
    expect(glowNodes().length).toBe(1);
    expect(writes).toBe(0);
    expect(scroller.scrollTop).toBe(42);
  });

  it("under prefers-reduced-motion applies the static ring, NOT the animated glow", () => {
    stubMatchMedia(true);
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);

    act(() => {
      useArtifactStore.getState().addArtifact(mk(9));
    });

    const newBtn = document.querySelector('[data-artifact-item="art_9"]')!;
    expect(newBtn.className).toContain("dp-arrival-ring");
    expect(newBtn.className).not.toContain("dp-arrival-glow");
    expect(glowNodes().length).toBe(0);
    expect(ringNodes().length).toBe(1);
  });

  it("suppresses the locator entirely in replay mode (no highlight, no pip)", () => {
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    // Enter replay with a cursor far in the future so the seeded artifacts stay
    // visible; the point is that arrivals must not glow while replaying.
    act(() => {
      useReplayStore.setState({ active: true, cursor: "2099-01-01T00:00:00.000Z" });
    });
    render(<ArtifactPanel />);

    act(() => {
      useArtifactStore.getState().addArtifact(mk(9));
    });

    expect(glowNodes().length).toBe(0);
    expect(ringNodes().length).toBe(0);
    expect(screen.queryByRole("button", { name: /jump to new artifact/i })).toBeNull();
  });

  it("shows an off-screen pip (a real button) that scrolls the new card into view on click", () => {
    // Force the geometry: the sidebar viewport is 0–100; the new card sits at
    // 200–220, i.e. BELOW the fold.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.getAttribute("data-testid") === "sidebar-scroll") return rect(0, 100);
        if (this.getAttribute("data-artifact-item") === "art_9") return rect(200, 220);
        return rect(0, 0);
      },
    );

    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);

    act(() => {
      useArtifactStore.getState().addArtifact(mk(9));
    });

    const pip = screen.getByRole("button", { name: /jump to new artifact below/i });
    expect(pip.tagName).toBe("BUTTON");

    const target = document.querySelector('[data-artifact-item="art_9"]') as HTMLElement;
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy;

    fireEvent.click(pip);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps buildFlowGroups ordering identical (the locator must not re-sort)", () => {
    // Flow B starts before flow A; an orphan is oldest of all. Order must be by
    // each group's start time — unchanged by the locator work.
    const a1 = mk(5, { relatedArtifactIds: ["art_6"] });
    const a2 = mk(6);
    const b1 = mk(2, { relatedArtifactIds: ["art_3"] });
    const b2 = mk(3);
    const orphan = mk(1);
    const groups = buildFlowGroups([a1, a2, b1, b2, orphan]);
    expect([...groups.keys()]).toEqual(["art_1", "art_2", "art_5"]);
    expect(groups.get("art_2")!.map((x) => x.id)).toEqual(["art_2", "art_3"]);
    expect(groups.get("art_5")!.map((x) => x.id)).toEqual(["art_5", "art_6"]);
  });

  it("has zero serious/critical axe violations with a highlighted card + visible pip", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.getAttribute("data-testid") === "sidebar-scroll") return rect(0, 100);
        if (this.getAttribute("data-artifact-item") === "art_9") return rect(200, 220);
        return rect(0, 0);
      },
    );

    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    const { container } = render(<ArtifactPanel />);
    act(() => {
      useArtifactStore.getState().addArtifact(mk(9, { title: "Fresh finding" }));
    });

    // Both surfaces present before scanning.
    expect(glowNodes().length).toBe(1);
    expect(screen.getByRole("button", { name: /jump to new artifact/i })).toBeInTheDocument();

    const results = await axe.run(container, {
      // Zero disabled rules — same contract as the e2e a11y net.
      resultTypes: ["violations"],
    });
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      serious,
      serious.map((v) => `${v.id} (${v.impact})`).join("\n"),
    ).toEqual([]);
  });
});
