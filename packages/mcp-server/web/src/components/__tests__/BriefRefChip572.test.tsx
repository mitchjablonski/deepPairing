import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { DecisionArtifactView } from "../DecisionCard";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

/**
 * #572 slice A — the options card names its governing brief: text only, the
 * EXACT pinned version (never a successor), raw id + "version unknown" while
 * the brief is unavailable, raw + unavailable for an unreadable stored link.
 */
const now = "2026-10-24T00:00:00.000Z";
const OPTS = [
  { id: "a", title: "Redis", description: "d", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
  { id: "b", title: "Postgres", description: "d", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
];
const art = (over: Record<string, unknown>): Artifact => ({
  sessionId: "s1", version: 1, parentId: null, status: "draft", agentReasoning: null, createdAt: now, updatedAt: now, ...over,
}) as unknown as Artifact;
const decision = (briefRef: unknown, over: Record<string, unknown> = {}) => art({
  id: "art_d", type: "decision", title: "Which store?", content: { context: "c", decisionId: "dec_d", options: OPTS },
  ...(briefRef !== undefined ? { briefRef } : {}), ...over,
});
const spec = (id: string, over: Record<string, unknown> = {}) => art({
  id, type: "spec", title: "Auth brief",
  content: { objective: "o", requirements: [{ id: "REQ-1" }, { id: "REQ-2" }, { id: "REQ-2" }], edgePaths: [{ path: "id-less" }, { path: "x" }, { path: "y" }] },
  ...over,
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))));
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }], disconnectedSince: null } as unknown as Parameters<typeof useConnectionStore.setState>[0]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const setArtifacts = (artifacts: Artifact[]) =>
  useArtifactStore.setState({ artifacts } as unknown as Parameters<typeof useArtifactStore.setState>[0]);

describe("#572 — BriefRefChip on the options card", () => {
  it("a card without a ref renders no chip (legacy unchanged)", () => {
    const d = decision(undefined);
    setArtifacts([d]);
    render(<DecisionArtifactView artifact={d} />);
    expect(screen.queryByTestId("brief-ref-chip")).toBeNull();
  });

  it("names the exact version and grains, marks unknown/ambiguous, and opens THAT version", () => {
    const v1 = spec("art_b1", { status: "superseded" });
    const v2 = spec("art_b2", { parentId: "art_b1", version: 2 });
    const d = decision({ artifactId: "art_b1", requirementIds: ["REQ-1", "REQ-2", "REQ-9"], edgePathIds: ["2"] });
    setArtifacts([v1, v2, d]);
    render(<DecisionArtifactView artifact={d} />);
    const chip = screen.getByTestId("brief-ref-chip");
    expect(chip).toHaveTextContent('Exception to "Auth brief" v1 · REQ-1, REQ-2 (ambiguous), REQ-9 (unknown), edge path 2 (unknown) (superseded)');
    expect(chip.getAttribute("data-brief-state")).toBe("closed");
    expect(chip.textContent).not.toContain("v2");
    fireEvent.click(chip);
    // The pinned v1 — not the live successor selectArtifact would resolve to.
    expect(useArtifactStore.getState().selectedArtifactId).toBe("art_b1");
  });

  it("before the brief hydrates (or in another session): the raw id, version unknown, not clickable", () => {
    const other = spec("art_b1", { sessionId: "s2" });
    const d = decision({ artifactId: "art_b1", requirementIds: ["REQ-1"] });
    setArtifacts([other, d]);
    render(<DecisionArtifactView artifact={d} />);
    const chip = screen.getByTestId("brief-ref-chip");
    expect(chip).toHaveTextContent("Exception to brief art_b1 (version unknown, brief unavailable) · REQ-1");
    expect(chip.tagName).not.toBe("BUTTON");
    expect(chip.getAttribute("data-brief-state")).toBe("unavailable");
  });

  it("a malformed stored link still renders, raw and unavailable", () => {
    const d = decision({ artifactId: "art_b1", requirementIds: "REQ-1" });
    setArtifacts([d]);
    render(<DecisionArtifactView artifact={d} />);
    const chip = screen.getByTestId("brief-ref-chip");
    expect(chip).toHaveTextContent("Exception to art_b1 (link unreadable or out of policy, unavailable)");
    expect(chip.getAttribute("data-brief-state")).toBe("malformed");
  });

  it("a shape-valid but out-of-policy stored ref (duplicate, blank, over-cap) is unavailable and not clickable, even with the brief present", () => {
    for (const briefRef of [
      { artifactId: "art_b1", requirementIds: ["REQ-1", "REQ-1"] },
      { artifactId: "art_b1", requirementIds: ["  "] },
      { artifactId: "art_b1", requirementIds: Array.from({ length: 9 }, (_, i) => `REQ-${i}`) },
      { artifactId: "art_b1", edgePathIds: ["a".repeat(65)] },
    ]) {
      const d = decision(briefRef);
      setArtifacts([spec("art_b1"), d]);
      const { unmount } = render(<DecisionArtifactView artifact={d} />);
      const chip = screen.getByTestId("brief-ref-chip");
      expect(chip.getAttribute("data-brief-state"), JSON.stringify(briefRef)).toBe("malformed");
      expect(chip.tagName).not.toBe("BUTTON");
      expect(chip.textContent).not.toContain("v1");
      // Loaded unchanged.
      expect(useArtifactStore.getState().artifacts.find((a) => a.id === "art_d")!.briefRef).toEqual(briefRef);
      unmount();
    }
  });

  it("renders agent ids as text, never markup", () => {
    const b = spec("art_b1", { content: { objective: "o", requirements: [{ id: "<img src=x onerror=alert(1)>" }] } });
    const d = decision({ artifactId: "art_b1", requirementIds: ["<img src=x onerror=alert(1)>"] });
    setArtifacts([b, d]);
    const { container } = render(<DecisionArtifactView artifact={d} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("brief-ref-chip")).toHaveTextContent("<img src=x onerror=alert(1)>");
  });
});
