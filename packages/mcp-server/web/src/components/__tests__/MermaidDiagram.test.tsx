import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MermaidDiagram, repairMermaidSource, mermaidThemeFor } from "../MermaidDiagram";
import { useOverlayStore } from "../../stores/overlay";
import { usePreferencesStore } from "../../stores/preferences";

// Mermaid needs real SVG layout, so mock it: control render() per test to
// exercise both the success path and the fuzzy-safe fallback.
const renderMock = vi.hoisted(() => vi.fn());
const initializeMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({
  default: { initialize: initializeMock, render: renderMock },
}));

beforeEach(() => {
  renderMock.mockReset();
  useOverlayStore.setState({ count: 0 });
});

describe("MermaidDiagram", () => {
  it("renders the SVG when mermaid succeeds, with a view-source toggle", async () => {
    renderMock.mockResolvedValue({ svg: "<svg aria-label='diagram'><text>A→B</text></svg>" });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(screen.getByText("View source")).toBeInTheDocument();
  });

  it("#189 — themes mermaid to the app theme: light picks the light-filled 'default' theme, not 'dark'", async () => {
    // The pure mapping: light nodes on white cards; dark nodes on the dark surface.
    expect(mermaidThemeFor("light")).toBe("default");
    expect(mermaidThemeFor("dark")).toBe("dark");

    // And the component re-initializes mermaid to that theme before rendering,
    // read from the live <html data-theme>. (Real node fills are exercised by the
    // e2e light-mermaid check; the engine is mocked here.)
    document.documentElement.setAttribute("data-theme", "light");
    initializeMock.mockClear();
    renderMock.mockResolvedValue({ svg: "<svg aria-label='diagram'><g class='node'></g></svg>" });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    const themes = initializeMock.mock.calls.map((c) => (c[0] as { theme?: string })?.theme);
    expect(themes[themes.length - 1]).toBe("default");
    document.documentElement.removeAttribute("data-theme");
  });

  it("#189 Fix 2 — a theme toggle re-themes WITHOUT blanking the diagram (svg stays; no 'Rendering…')", async () => {
    renderMock.mockResolvedValue({ svg: "<svg aria-label='diagram'><g class='node'></g></svg>" });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());

    // Toggle the app theme — a theme-only re-render (same source).
    act(() => {
      const cur = usePreferencesStore.getState().theme;
      usePreferencesStore.getState().setTheme(cur === "light" ? "dark" : "light");
    });
    // Synchronously after the state flush the OLD svg is still mounted — it is
    // NEVER nulled to the "Rendering diagram…" placeholder (which pre-fix
    // unmounted DiagramRegionLayer and dropped an open region composer).
    expect(document.querySelector(".dp-mermaid svg")).not.toBeNull();
    expect(screen.queryByText(/Rendering diagram/i)).toBeNull();
    // The re-themed svg swaps in on resolve; still present, never blanked.
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    usePreferencesStore.getState().setTheme("dark"); // restore for later tests
  });

  it("opens a fullscreen lightbox via Expand and closes it (✕ + Esc)", async () => {
    const user = userEvent.setup();
    renderMock.mockResolvedValue({ svg: "<svg aria-label='diagram'><text>A→B</text></svg>" });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());

    // No lightbox until asked.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useOverlayStore.getState().count).toBe(0);
    await user.click(screen.getByRole("button", { name: /expand/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.querySelector(".dp-mermaid-full svg")).not.toBeNull(); // big copy of the SVG
    // Registers as an overlay so App suppresses the global j/k/a/r/q shortcuts…
    expect(useOverlayStore.getState().count).toBe(1);
    // …and focus is trapped INTO the dialog (not stranded on the Expand button).
    expect(dialog.contains(document.activeElement)).toBe(true);

    // ✕ closes + releases the overlay lock.
    await user.click(screen.getByRole("button", { name: /close fullscreen/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useOverlayStore.getState().count).toBe(0);

    // Esc closes too (dispatched on the dialog — focus is trapped inside it).
    await user.click(screen.getByRole("button", { name: /expand/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useOverlayStore.getState().count).toBe(0);
  });

  it("repairs an unparseable diagram (unquoted labels) and renders it with an 'auto-formatted' note", async () => {
    // First render (raw) fails like the real parser; the repaired retry succeeds.
    renderMock
      .mockRejectedValueOnce(new Error("Parse error on line 2"))
      .mockResolvedValueOnce({ svg: "<svg aria-label='repaired'><text>ok</text></svg>" });
    render(<MermaidDiagram source={"flowchart TD\n  A[Curse: Weak (x), #79] --> B"} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(screen.getByText(/auto-formatted/i)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t render this diagram/i)).not.toBeInTheDocument();
    // The repaired source (quoted label) was what got re-rendered.
    expect(renderMock).toHaveBeenLastCalledWith(expect.any(String), expect.stringContaining('A["Curse: Weak (x), #79"]'));
  });

  it("initializes mermaid with suppressErrorRendering so it never draws its own 'Syntax error' graphic", async () => {
    // The bomb graphic leaks to the bottom of the page; suppressing it makes
    // mermaid THROW instead (the existing catch shows the fallback + reports).
    renderMock.mockResolvedValue({ svg: "<svg aria-label='diagram'><text>ok</text></svg>" });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(initializeMock).toHaveBeenCalled();
    const cfg = initializeMock.mock.calls[0]![0] as Record<string, unknown>;
    // The suppression flag is present; the strict sanitization is untouched.
    expect(cfg).toMatchObject({ suppressErrorRendering: true, securityLevel: "strict" });
  });

  it("removes mermaid's temp layout node from the DOM when a render fails (no orphan leak)", async () => {
    // Real mermaid.render(id, src) appends `#d<id>` wrapping `#<id>` to
    // document.body to lay the diagram out. Simulate that, then throw like a bad
    // diagram does — the component must remove the node it minted so nothing
    // leaks to the bottom of the page.
    const seenIds: string[] = [];
    renderMock.mockImplementation(async (id: string) => {
      seenIds.push(id);
      const wrap = document.createElement("div");
      wrap.id = `d${id}`;
      const svgNode = document.createElement("div");
      svgNode.id = id;
      wrap.appendChild(svgNode);
      document.body.appendChild(wrap);
      throw new Error("Parse error on line 2");
    });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(screen.getByText(/Couldn.t render this diagram/i)).toBeInTheDocument());
    expect(seenIds.length).toBeGreaterThan(0);
    // Failure still sets the error fallback (unchanged) AND leaves no orphan.
    for (const id of seenIds) {
      expect(document.getElementById(id)).toBeNull();
      expect(document.getElementById(`d${id}`)).toBeNull();
    }
  });

  it("degrades to the source (fuzzy-safe) instead of crashing when it can't render", async () => {
    // Empty/blank source hits the same fallback branch a mermaid parse error
    // does: show the source, never throw. (mermaid is never even invoked here.)
    render(<MermaidDiagram source="   " />);
    await waitFor(() => expect(screen.getByText(/Couldn.t render this diagram/i)).toBeInTheDocument());
    expect(renderMock).not.toHaveBeenCalled();
  });
});

describe("repairMermaidSource", () => {
  it("quotes punctuation labels and turns \\n into <br/>", () => {
    const out = repairMermaidSource("flowchart TD\n  A[Curse: Weak (x)\\nline2] --> B{floor(D)}");
    expect(out).toContain('A["Curse: Weak (x)<br/>line2"]');
    expect(out).toContain('B{"floor(D)"}');
  });

  it("quotes an edge label with punctuation", () => {
    expect(repairMermaidSource("A -->|deals D (STR)| B")).toContain('|"deals D (STR)"|');
  });

  it("preserves a dotted edge while quoting its inline text", () => {
    const out = repairMermaidSource("A[X] -.tanky (new Act).-> B[Y]");
    expect(out).toContain('-."tanky (new Act)".->'); // still dotted, now quoted
  });

  it("leaves an already-valid diagram byte-for-byte unchanged (repair is on-failure-safe)", () => {
    const valid = "flowchart TD\n  A[Start] --> B{OK}\n  B -->|yes| C[Done]";
    expect(repairMermaidSource(valid)).toBe(valid);
  });
});
