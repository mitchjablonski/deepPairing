/**
 * P2 (round-11 UX #7) — the narrow-width SEARCH affordance, finished.
 *
 * Round 10 asked for a LABELED, higher-contrast search at ~900px (the VS Code
 * webview width). #231 shipped half of it: the magnifier icon became
 * always-visible, but the word "Search" kept `hidden min-[1100px]:inline` and
 * the control kept the muted, border-less treatment of a tertiary nav item — so
 * in the webview it still read as two faint glyphs. jsdom has no media queries,
 * so the responsive half is pinned by CLASS (no `hidden`/`min-[…]` gate on the
 * label) and the contrast half by the control's own classes; the rendered look
 * is captured by the Playwright 900px screenshots.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "../../App";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

const art = (id: string) =>
  ({
    id, sessionId: "s1", type: "research", version: 1, parentId: null,
    title: id, status: "draft", content: {}, agentReasoning: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
  }) as any;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } })),
  ));
  useArtifactStore.getState().reset();
  useArtifactStore.setState({ artifacts: [art("a1")], selectedArtifactId: "a1" });
  useConnectionStore.setState({ connected: true, hydrated: true } as any);
});
afterEach(() => vi.unstubAllGlobals());

describe("P2 — the search affordance at narrow widths", () => {
  it("shows the word 'Search' at EVERY width (no min-width gate on the label)", () => {
    render(<App />);
    const label = screen.getByTestId("search-label");
    expect(label).toBeInTheDocument();
    expect(label.textContent).toBe("Search");
    // The round-10 gap: `hidden min-[1100px]:inline` hid the word in the webview.
    expect(label.className).not.toContain("hidden");
    expect(label.className).not.toContain("min-[");
  });

  it("reads as a primary affordance: bordered + secondary (not muted) text", () => {
    render(<App />);
    const btn = screen.getByRole("button", { name: /Open the command palette/i });
    expect(btn.className).toMatch(/\bborder\b/);
    expect(btn.className).toContain("text-text-secondary");
    expect(btn.className).not.toContain("text-text-muted");
    // The ⌘K hint still rides along, after the word.
    expect(btn.textContent).toMatch(/Search.*⌘K/);
  });
});
