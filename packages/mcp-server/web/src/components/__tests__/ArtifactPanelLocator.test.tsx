import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { useArtifactStore } from "../../stores/artifact";
import { useReplayStore } from "../../stores/replay";
import { ArtifactPanel, buildFlowGroups } from "../ArtifactPanel";
import type { Artifact } from "@deeppairing/shared";

/**
 * New-item locator (#new-item-locator) — a live-arriving artifact card gets a
 * gentle glow (or a static ring under prefers-reduced-motion) and, when it's
 * off-viewport, an "off-screen pip" points the way. The arrival NEVER moves
 * scroll. These tests pin the correctness constraints that make the feature
 * safe: no load-glow (single-session AND the async aggregator backfill), no
 * scroll disturbance, replay suppression (proved by a delta), and the a11y
 * contract (real button + polite announcement).
 *
 * Timers are faked so the hydration-settle window and the highlight fade are
 * driven deterministically. Hydration is a quiescence signal: the panel only
 * starts treating additions as arrivals after the population has been quiet for
 * HYDRATION_SETTLE_MS (750ms in the component).
 */
const SETTLE_ADVANCE = 800; // > HYDRATION_SETTLE_MS

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

/** Advance past the hydration-settle window so subsequent additions count as
 *  live arrivals (only meaningful when the store was non-empty at render). */
function hydrate() {
  act(() => {
    vi.advanceTimersByTime(SETTLE_ADVANCE);
  });
}

function addLive(artifact: Artifact) {
  act(() => {
    useArtifactStore.getState().addArtifact(artifact);
  });
}

function glowNodes() {
  return document.querySelectorAll(".dp-arrival-glow");
}
function ringNodes() {
  return document.querySelectorAll(".dp-arrival-ring");
}

beforeEach(() => {
  vi.useFakeTimers();
  useArtifactStore.getState().reset();
  useReplayStore.getState().exitReplay();
  stubMatchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ArtifactPanel new-item locator", () => {
  it("does NOT highlight anything on initial population (the load-glow failure mode)", () => {
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);
    // Every artifact is 'new' on first render — none may glow, before or after
    // hydration settles.
    expect(glowNodes().length).toBe(0);
    hydrate();
    expect(glowNodes().length).toBe(0);
    expect(ringNodes().length).toBe(0);
    expect(screen.getByTestId("arrival-live-region").textContent).toBe("");
  });

  it("does NOT glow the aggregator's async cross-session backfill (mount empty, add N later)", () => {
    // The reviewer's repro: a global/aggregator tab mounts with an EMPTY store
    // (bound session has nothing yet), then MultiAgentSync back-fills OTHER
    // sessions' HISTORY via async addArtifact loops a few ticks after mount.
    // Those historical cards must NOT be treated as arrivals.
    render(<ArtifactPanel />); // empty store at mount

    // Backfill lands after mount, in a couple of ticks (as the async loops do).
    act(() => {
      for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    });
    act(() => {
      vi.advanceTimersByTime(50);
      for (let i = 4; i <= 6; i++) useArtifactStore.getState().addArtifact(mk(i));
    });

    // Zero glow, zero ring, and NOTHING announced — the whole backfill is
    // absorbed as already-seen.
    expect(glowNodes().length).toBe(0);
    expect(ringNodes().length).toBe(0);
    expect(screen.getByTestId("arrival-live-region").textContent).toBe("");

    // And it still works afterwards: once hydrated, a genuine arrival glows.
    hydrate();
    addLive(mk(9, { title: "Genuinely new" }));
    expect(glowNodes().length).toBe(1);
  });

  it("highlights a LIVE-added artifact and announces it politely", () => {
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);
    hydrate();
    expect(glowNodes().length).toBe(0);

    addLive(mk(9, { title: "Fresh finding" }));

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
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);
    hydrate();

    addLive(mk(9));
    expect(glowNodes().length).toBe(1);

    act(() => {
      vi.advanceTimersByTime(4600);
    });
    expect(glowNodes().length).toBe(0);
  });

  it("does NOT write the sidebar scrollTop on arrival (scroll is sacred)", () => {
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);
    hydrate();
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

    addLive(mk(9));

    // The arrival highlighted the card but never touched scroll position.
    expect(glowNodes().length).toBe(1);
    expect(writes).toBe(0);
    expect(scroller.scrollTop).toBe(42);
  });

  it("under prefers-reduced-motion applies the static ring, NOT the animated glow", () => {
    stubMatchMedia(true);
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);
    hydrate();

    addLive(mk(9));

    const newBtn = document.querySelector('[data-artifact-item="art_9"]')!;
    expect(newBtn.className).toContain("dp-arrival-ring");
    expect(newBtn.className).not.toContain("dp-arrival-glow");
    expect(glowNodes().length).toBe(0);
    expect(ringNodes().length).toBe(1);
  });

  it("suppresses the locator in replay — replay OFF glows the arrival, replay ON does not (delta)", () => {
    // Control: replay OFF → the arrival DOES glow.
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    const first = render(<ArtifactPanel />);
    hydrate();
    addLive(mk(9));
    expect(glowNodes().length).toBe(1);

    first.unmount();
    cleanup();
    useArtifactStore.getState().reset();

    // Treatment: same arrival sequence, but replay ON → NO glow. The contrast
    // proves suppression works, not that the feature is merely absent.
    act(() => {
      useReplayStore.setState({ active: true, cursor: "2099-01-01T00:00:00.000Z" });
    });
    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);
    hydrate();
    addLive(mk(9));
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
    hydrate();

    addLive(mk(9));

    const pip = screen.getByRole("button", { name: /jump to new artifact below/i });
    expect(pip.tagName).toBe("BUTTON");

    const target = document.querySelector('[data-artifact-item="art_9"]') as HTMLElement;
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy;

    fireEvent.click(pip);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("meets the a11y contract for the highlighted card + visible pip", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.getAttribute("data-testid") === "sidebar-scroll") return rect(0, 100);
        if (this.getAttribute("data-artifact-item") === "art_9") return rect(200, 220);
        return rect(0, 0);
      },
    );

    for (let i = 1; i <= 3; i++) useArtifactStore.getState().addArtifact(mk(i));
    render(<ArtifactPanel />);
    hydrate();
    addLive(mk(9, { title: "Fresh finding" }));

    // 1) The pip is a real <button> with an accessible name (aria-label).
    const pip = screen.getByRole("button", { name: /jump to new artifact/i });
    expect(pip.tagName).toBe("BUTTON");
    expect(pip.getAttribute("aria-label")).toBeTruthy();

    // 2) It is NOT nested inside another interactive element (no
    //    nested-interactive: the pip is a sibling of the scroll container).
    let ancestor = pip.parentElement;
    while (ancestor) {
      expect(["BUTTON", "A"]).not.toContain(ancestor.tagName);
      ancestor = ancestor.parentElement;
    }

    // 3) The aria-live region exists and is polite (one announcement per
    //    arrival), so SR users learn of the arrival without the visual glow.
    const live = screen.getByTestId("arrival-live-region");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("New artifact: Fresh finding");

    // 4) The glow is decorative: it's a class on the artifact button itself,
    //    which keeps its own accessible name — it introduces no empty
    //    interactive element and no aria-hidden focus trap.
    const glowing = document.querySelector(".dp-arrival-glow") as HTMLElement;
    expect(glowing.tagName).toBe("BUTTON");
    expect(glowing.getAttribute("aria-hidden")).toBeNull();
    expect(glowing.textContent).toContain("Fresh finding");
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
});
