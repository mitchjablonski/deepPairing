import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("degrades to the source (fuzzy-safe) instead of crashing when it can't render", async () => {
    // Empty/blank source hits the same fallback branch a mermaid parse error
    // does: show the source, never throw. (mermaid is never even invoked here.)
    render(<MermaidDiagram source="   " />);
    await waitFor(() => expect(screen.getByText(/Couldn.t render this diagram/i)).toBeInTheDocument());
    expect(renderMock).not.toHaveBeenCalled();
  });
});
