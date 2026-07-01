import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MermaidDiagram } from "../MermaidDiagram";

// Mermaid needs real SVG layout, so mock it: control render() per test to
// exercise both the success path and the fuzzy-safe fallback.
const renderMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: renderMock },
}));

beforeEach(() => renderMock.mockReset());

describe("MermaidDiagram", () => {
  it("renders the SVG when mermaid succeeds, with a view-source toggle", async () => {
    renderMock.mockResolvedValue({ svg: "<svg aria-label='diagram'><text>A→B</text></svg>" });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(screen.getByText("View source")).toBeInTheDocument();
  });

  it("opens a fullscreen lightbox via Expand and closes it (✕ + Esc)", async () => {
    const user = userEvent.setup();
    renderMock.mockResolvedValue({ svg: "<svg aria-label='diagram'><text>A→B</text></svg>" });
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());

    // No lightbox until asked.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /expand/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.querySelector(".dp-mermaid-full svg")).not.toBeNull(); // big copy of the SVG

    // ✕ closes.
    await user.click(screen.getByRole("button", { name: /close fullscreen/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Esc closes too.
    await user.click(screen.getByRole("button", { name: /expand/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("degrades to the source (fuzzy-safe) instead of crashing when it can't render", async () => {
    // Empty/blank source hits the same fallback branch a mermaid parse error
    // does: show the source, never throw. (mermaid is never even invoked here.)
    render(<MermaidDiagram source="   " />);
    await waitFor(() => expect(screen.getByText(/Couldn.t render this diagram/i)).toBeInTheDocument());
    expect(renderMock).not.toHaveBeenCalled();
  });
});
