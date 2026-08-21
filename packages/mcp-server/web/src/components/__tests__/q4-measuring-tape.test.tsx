/**
 * Q4 (round-12 "the UX rider") — pins for the four mechanical defects a
 * measuring tape found on v0.1.34, plus the glyph riders. Each `it` names the
 * MEASUREMENT that motivated it, so a future edit that quietly re-breaks the
 * geometry fails with the original number in the message rather than a bare
 * "expected true".
 *
 * The contrast half lives in `web/src/__tests__/token-contrast.test.ts` (it
 * parses index.css and needs no DOM); the landmark/heading-order half is
 * additionally scanned by axe in `e2e/a11y.e2e.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { MermaidDiagram } from "../MermaidDiagram";
import { ChangesetArtifact } from "../artifacts/ChangesetArtifact";
import { ArtifactPanel } from "../ArtifactPanel";
import { ResearchArtifact } from "../artifacts/ResearchArtifact";
import { WalkMeThroughButton } from "../WalkMeThrough";
import { useArtifactStore } from "../../stores/artifact";
import { useOverlayStore } from "../../stores/overlay";

const renderMock = vi.hoisted(() => vi.fn());
const initializeMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize: initializeMock, render: renderMock } }));

beforeEach(() => {
  renderMock.mockReset();
  renderMock.mockResolvedValue({ svg: "<svg aria-label='diagram'><g class='node'></g></svg>" });
  useOverlayStore.setState({ count: 0 });
  useArtifactStore.setState({ artifacts: [], comments: {}, selectedArtifactId: null });
});

// ---------------------------------------------------------------------------
// 1. Mermaid: height cap + controls above the canvas
// ---------------------------------------------------------------------------

describe("Q4 #1 — the diagram well is capped and its controls sit ABOVE it", () => {
  it("caps the well at 60vh with internal scroll (was: max-width only, so a 13-node flowchart rendered a 1954px-tall SVG in a 1121px container)", async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    const well = document.querySelector(".dp-mermaid-well") as HTMLElement;
    expect(well).not.toBeNull();
    expect(well.className).toContain("max-h-[60vh]");
    expect(well.className).toContain("overflow-auto");
  });

  it("makes the capped well keyboard-scrollable (axe scrollable-region-focusable: a cap that hides content a mouse-less reader can't reach is a new barrier)", async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    const well = document.querySelector(".dp-mermaid-well") as HTMLElement;
    expect(well.tabIndex).toBe(0);
    // role=group, NOT region — one landmark per diagram would flood the rotor.
    expect(well.getAttribute("role")).toBe("group");
    expect(well.getAttribute("aria-label")).toMatch(/diagram/i);
  });

  it("puts Expand + View source BEFORE the canvas in DOM order (they measured 1416px BELOW the fold — you had to scroll past the problem to reach its remedy)", async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    const controls = document.querySelector(".dp-mermaid-controls") as HTMLElement;
    const well = document.querySelector(".dp-mermaid-well") as HTMLElement;
    expect(controls).not.toBeNull();
    expect(hasExactText(controls, "Expand")).toBe(true);
    expect(hasExactText(controls, "View source")).toBe(true);
    // DOCUMENT_POSITION_FOLLOWING === 4: the well comes AFTER the controls.
    expect(controls.compareDocumentPosition(well) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the region overlay INSIDE the scroll container, so highlights scroll with the diagram instead of drifting off it", async () => {
    render(
      <MermaidDiagram
        source="graph TD; A-->B"
        region={{ artifactId: "art_1", visualId: "v1" }}
      />,
    );
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    const well = document.querySelector(".dp-mermaid-well") as HTMLElement;
    const host = document.querySelector(".dp-mermaid") as HTMLElement;
    // The overlay is a SIBLING of the host, and both are inside the scrollport:
    // DiagramRegionLayer measures the SVG against its own parentElement and only
    // re-measures on resize, so a host that scrolled alone would desync them.
    expect(well.contains(host)).toBe(true);
    expect(host.parentElement!.className).toContain("relative");
    expect(well.contains(host.parentElement!)).toBe(true);
  });

  it("Q4 review (H1/M3) — the region layer's FLOW chrome is portalled OUT of the capped well", async () => {
    render(<MermaidDiagram source="graph TD; A-->B" region={{ artifactId: "art_1", visualId: "v1" }} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    const well = document.querySelector(".dp-mermaid-well") as HTMLElement;
    const chrome = document.querySelector(".dp-mermaid-chrome") as HTMLElement;
    expect(chrome).not.toBeNull();
    // The chrome host is a SIBLING AFTER the well, never inside it: anything
    // inside gets clipped by the 60vh cap (the ⌨ path, the locator list and the
    // narrow block composer all measured 817-834px below the visible area).
    expect(well.contains(chrome)).toBe(false);
    expect(well.compareDocumentPosition(chrome) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and the canvas-anchored overlay stays INSIDE, scrolling with the diagram.
    const overlay = document.querySelector('[data-testid="dp-region-overlay"]') as HTMLElement;
    expect(well.contains(overlay)).toBe(true);
  });

  it("Q4 review (H2) — the well marks itself as the scrollport the popover must clamp to", async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    const well = document.querySelector(".dp-mermaid-well") as HTMLElement;
    expect(well.hasAttribute("data-dp-scrollport")).toBe(true);
  });

  it("leaves the Q5 skeleton and the broken-diagram degrade untouched", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 1"));
    render(<MermaidDiagram source="not a diagram" />);
    await waitFor(() => expect(screen.getByText(/Couldn.t render this diagram/)).toBeInTheDocument());
    // The degrade path shows source and never mounts a capped well.
    expect(document.querySelector(".dp-mermaid-well")).toBeNull();
  });
});

/** Small helper: does `root` contain an element whose trimmed text is `text`? */
function hasExactText(root: HTMLElement, text: string): boolean {
  return [...root.querySelectorAll("*")].some((el) => el.textContent?.trim() === text);
}

// ---------------------------------------------------------------------------
// 2. CHANGED FILES picker: head-truncation
// ---------------------------------------------------------------------------

function deepChangeset(paths: string[]): Artifact {
  return {
    id: "art_cs",
    sessionId: "s1",
    type: "changeset",
    version: 1,
    parentId: null,
    title: "Deep paths",
    status: "draft",
    content: {
      summary: "s",
      files: paths.map((path) => ({
        path,
        changeType: "modified" as const,
        hunks: [{ lines: [{ kind: "add" as const, content: "x", newLine: 1 }] }],
      })),
      reviewState: {},
    },
    agentReasoning: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Artifact;
}

describe("Q4 #2 — the CHANGED FILES picker keeps the basename", () => {
  const paths = [
    "packages/mcp-server/src/mcp/tools/check-feedback-delivery.ts",
    "packages/mcp-server/web/src/components/artifacts/ChangesetArtifact.tsx",
    "packages/shared/src/schemas/artifact.ts",
  ];

  function renderRail() {
    const art = deepChangeset(paths);
    useArtifactStore.setState({ artifacts: [art], comments: {}, selectedArtifactId: art.id });
    render(<ChangesetArtifact artifact={art} />);
    return art;
  }

  // Q4 review (M6) — the honest claim. A 240px rail leaves the label ~88-96px
  // (~11-12 mono chars, measured in q4-capture.e2e.ts), so a long basename
  // still clips its own tail. What changed is WHICH HALF survives: the file's
  // own name instead of the "packages/mcp-server/…" prefix every row shared.
  it("leads every row with the FILENAME (was: a tail-first `truncate` in a 240px rail, so all three read 'packages/mc…')", () => {
    renderRail();
    const basenames = screen.getAllByTestId("changeset-rail-file-basename").map((n) => n.textContent);
    expect(basenames).toEqual([
      "check-feedback-delivery.ts",
      "ChangesetArtifact.tsx",
      "artifact.ts",
    ]);
  });

  it("collapses the DIRECTORY first — the basename only gives up characters once the directory is gone", () => {
    renderRail();
    for (const base of screen.getAllByTestId("changeset-rail-file-basename")) {
      const label = base.parentElement!;
      const dir = label.firstElementChild as HTMLElement;
      // The dimmed directory is the first child and carries the ellipsis.
      expect(dir.className).toContain("truncate");
      expect(dir.className).toMatch(/text-text-(muted|secondary)/);
      // 240px of rail can be narrower than a bare basename, so BOTH halves have
      // to be shrinkable — otherwise the filename overflows onto the stat bar
      // instead of truncating. The weights decide who loses first: the
      // directory is ~1000× more willing to shrink.
      expect(Number(dir.style.flexShrink)).toBeGreaterThan(Number(base.style.flexShrink) * 100);
      expect(Number(base.style.flexShrink)).toBeGreaterThan(0);
    }
  });

  it("steps the dim UP on the selected row — text-muted on bg-surface-active is 4.16:1 in the dark theme", () => {
    renderRail();
    const dirs = screen.getAllByTestId("changeset-rail-file-dir");
    const active = document.querySelector('[aria-current="true"]')!;
    for (const dir of dirs) {
      const onActiveRow = active.contains(dir);
      expect(dir.className).toContain(onActiveRow ? "text-text-secondary" : "text-text-muted");
    }
  });

  it("the file HEADER keeps its never-shrink basename (the P2 behaviour is untouched)", () => {
    renderRail();
    const headerBase = screen.getByTestId("changeset-file-basename");
    expect(headerBase.className).toContain("shrink-0");
    expect(headerBase.className).not.toContain("truncate");
  });

  it("keeps the full path reachable as a tooltip on every row", () => {
    renderRail();
    const labels = screen.getAllByTestId("changeset-rail-file-path");
    expect(labels.map((l) => l.getAttribute("title"))).toEqual(paths);
  });

  it("does not collide with the file HEADER's pins (one file renders both a rail row and a header)", () => {
    renderRail();
    // Distinct testid stems — the header query stays single-element.
    expect(() => screen.getByTestId("changeset-file-basename")).not.toThrow();
  });

  it("Q4 #4 — 'Changed files' is a real heading, not a styled div", () => {
    renderRail();
    const h = screen.getByRole("heading", { name: /changed files/i });
    expect(h.tagName).toBe("H3");
    // Visual styling is byte-for-byte the old div's.
    expect(h.className).toContain("uppercase");
    expect(h.className).toContain("tracking-wide");
    expect(h.className).toContain("text-text-muted");
  });

  it("Q4 #5 — the blue unread-comment dot is named, not a bare ● in innerText", () => {
    const art = deepChangeset([paths[0]!]);
    useArtifactStore.setState({
      artifacts: [art],
      comments: {
        [art.id]: [{
          id: "c1", artifactId: art.id, author: "human", content: "why?",
          target: { artifactId: art.id, filePath: paths[0]!, lineStart: 1 },
          createdAt: new Date().toISOString(),
        }] as never,
      },
      selectedArtifactId: art.id,
    });
    render(<ChangesetArtifact artifact={art} />);
    // The badge is the span that CONTAINS an aria-hidden ●, not the ● itself.
    const badges = [...document.querySelectorAll("span")].filter(
      (s) => s.querySelector(':scope > [aria-hidden="true"]')?.textContent === "●",
    );
    expect(badges.length).toBeGreaterThan(0);
    for (const b of badges) {
      // The glyph is decoration; a noun sits beside the count for AT.
      expect(b.textContent).toMatch(/open comment/);
      expect(b.querySelector(".sr-only")).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2b. R2 — the index.ts×N degenerate case (round 13's regression on Q4 #2)
// ---------------------------------------------------------------------------

describe("R2 — the picker survives identical basenames", () => {
  const indexPaths = [
    "packages/mcp-server/src/http/index.ts",
    "packages/mcp-server/src/store/index.ts",
    "packages/shared/src/index.ts",
  ];

  function renderIndexRail() {
    const art = deepChangeset(indexPaths);
    useArtifactStore.setState({ artifacts: [art], comments: {}, selectedArtifactId: art.id });
    render(<ChangesetArtifact artifact={art} />);
  }

  /**
   * Q4 made the DIRECTORY the disposable half — correct when basenames differ,
   * and a total loss when they don't: three rows of `index.ts` under three
   * different directories collapsed to three identical labels, in the one
   * control whose whole job is telling rows apart. R2 splits the directory so
   * the IMMEDIATE PARENT (the disambiguating token, and the cheapest one)
   * survives while the shared ancestors collapse first.
   */
  it("three index.ts rows under different directories render three DISTINCT labels", () => {
    renderIndexRail();
    const labels = screen.getAllByTestId("changeset-rail-file-path").map((n) => n.textContent);
    expect(labels).toEqual(["packages/mcp-server/src/http/index.ts", "packages/mcp-server/src/store/index.ts", "packages/shared/src/index.ts"]);
    // …and they stay distinct after the ancestors collapse — which is the
    // state the 240px rail actually renders.
    const parents = screen.getAllByTestId("changeset-rail-file-dir").map((n) => n.textContent);
    expect(parents).toEqual(["http/", "store/", "src/"]);
    expect(new Set(parents).size).toBe(3);
  });

  it("the ancestors are the first flex item and the most willing to shrink", () => {
    renderIndexRail();
    const ancestors = screen.getAllByTestId("changeset-rail-file-ancestors");
    const parents = screen.getAllByTestId("changeset-rail-file-dir");
    const bases = screen.getAllByTestId("changeset-rail-file-basename");
    expect(ancestors.map((n) => n.textContent)).toEqual([
      "packages/mcp-server/src/", "packages/mcp-server/src/", "packages/shared/",
    ]);
    for (let i = 0; i < 3; i++) {
      const a = Number(ancestors[i]!.style.flexShrink);
      const p = Number(parents[i]!.style.flexShrink);
      const b = Number(bases[i]!.style.flexShrink);
      // Collapse order: ancestors ≫ parent > basename.
      expect(a).toBeGreaterThan(p * 10);
      expect(p).toBeGreaterThan(b);
      expect(b).toBeGreaterThan(0);
    }
  });

  it("the pending chip no longer spends the row's width on the word 'review'", () => {
    renderIndexRail();
    for (const chip of screen.getAllByTitle("Not reviewed yet")) {
      // Visible text is the dash alone; the state is carried by tooltip +
      // sr-only noun. Round 13 measured "— review" at 58px of a 238px row.
      const visible = [...chip.querySelectorAll("span")]
        .filter((s) => !s.className.includes("sr-only"))
        .map((s) => s.textContent)
        .join("");
      expect(visible.trim()).toBe("—");
      expect(chip.textContent).toContain("not reviewed yet");
    }
  });

  it("the file HEADER keeps the undivided directory (the roomy, P2-pinned surface)", () => {
    renderIndexRail();
    expect(screen.queryByTestId("changeset-file-ancestors")).toBeNull();
    expect(screen.getByTestId("changeset-file-dir").textContent).toBe("packages/mcp-server/src/http/");
  });
});

// ---------------------------------------------------------------------------
// 4. Semantic structure — landmarks + heading levels
// ---------------------------------------------------------------------------

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_r",
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: "Session TTL findings",
    status: "draft",
    content: {
      summary: "s",
      findings: [
        { category: "security", detail: "d", significance: "high", evidence: "e" },
        { category: "testing", detail: "d2", significance: "low", evidence: "e2" },
        { category: "domain", detail: "d3", significance: "low", evidence: "e3" },
      ],
    },
    agentReasoning: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as Artifact;
}

describe("Q4 #4 — the app has real landmarks and a heading outline without skips", () => {
  beforeEach(() => {
    const art = artifact();
    useArtifactStore.setState({ artifacts: [art], comments: {}, selectedArtifactId: art.id });
  });

  it("the artifact rail is a NAV with an accessible name (was: a bare <div> outside every landmark)", () => {
    render(<ArtifactPanel />);
    expect(screen.getByRole("navigation", { name: /artifacts/i })).toBeInTheDocument();
  });

  it("the artifact title is h2, not h3 (the app's only h1 is the shell header — h1→h3 was a skip on the PRIMARY content path)", () => {
    render(<ArtifactPanel />);
    const title = screen.getByRole("heading", { name: /Session TTL findings/ });
    expect(title.tagName).toBe("H2");
  });

  it("artifact SECTION headings step to h3 under that h2 (Comments, …)", async () => {
    render(<ArtifactPanel />);
    expect((await screen.findByRole("heading", { name: /^Comments$/i })).tagName).toBe("H3");
  });

  it("the research body's FINDINGS section is h3 (it was h4 — one level below the h2 title with nothing at h3)", () => {
    render(<ResearchArtifact artifact={artifact()} />);
    expect(screen.getByRole("heading", { name: /^Findings/i }).tagName).toBe("H3");
  });

  it("no heading in the rendered panel skips a level", async () => {
    render(<ArtifactPanel />);
    await screen.findByRole("heading", { name: /^Comments$/i });
    const levels = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1]));
    // Every step DOWN the outline is at most one level at a time.
    let prev = levels[0] ?? 1;
    for (const lvl of levels) {
      expect(lvl - prev).toBeLessThanOrEqual(1);
      prev = lvl;
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Glyph riders
// ---------------------------------------------------------------------------

describe("Q4 #5 — the tofu-prone primary glyphs are inline SVG", () => {
  it("walk-me-through leads with a compass SVG, not the 🧭 emoji", () => {
    render(<WalkMeThroughButton target={{ kind: "needs-eyes", what: "the TTL refresh" }} />);
    const btn = screen.getByRole("button", { name: /explain this/i });
    expect(btn.textContent).not.toContain("🧭");
    expect(btn.querySelector("svg")).not.toBeNull();
  });
});
