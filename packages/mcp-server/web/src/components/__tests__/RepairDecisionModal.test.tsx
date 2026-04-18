import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepairDecisionModal } from "../RepairDecisionModal";

const baseProps = {
  sessionId: "session_abc",
  decisionContext: "Which cache layer?",
  options: [
    {
      id: "o1",
      title: "Redis",
      description: "In-memory",
      pros: ["fast"],
      cons: ["infra"],
      recommendation: true,
    },
    { id: "o2", title: "CDN edge cache", description: "Edge", pros: [], cons: [] },
  ],
  chosenOptionId: "o1",
  chosenReasoning: "existing infra",
  resolvedAt: "2026-04-10T10:00:00.000Z",
  decisionId: "dec_xyz",
  onClose: vi.fn(),
};

beforeEach(() => {
  baseProps.onClose = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: "saved", relPath: ".deeppairing/prompts/test.md" }),
  }));
  // happy-dom exposes navigator.clipboard as a getter-only property, so
  // assign writeText directly on the live clipboard object.
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
});

describe("RepairDecisionModal", () => {
  it("renders with the generated prompt including session + chosen option", () => {
    render(<RepairDecisionModal {...baseProps} />);
    const preview = screen.getByText(/Re-pair: reconsider/i);
    expect(preview).toBeInTheDocument();
    // The generated prompt shows up inside a <pre>; use within container
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("session_abc");
    expect(dialog).toHaveTextContent("Which cache layer?");
    expect(dialog).toHaveTextContent("Redis");
    expect(dialog).toHaveTextContent("existing infra");
  });

  it("live-updates the prompt when the user edits the note", async () => {
    render(<RepairDecisionModal {...baseProps} />);
    const dialog = screen.getByRole("dialog");
    const note = screen.getByPlaceholderText(/Team moved to serverless/i);
    await userEvent.type(note, "New serverless constraints");
    expect(dialog).toHaveTextContent(/Why I'm reconsidering.*New serverless constraints/);
  });

  it("Copy button writes the prompt to the clipboard", async () => {
    render(<RepairDecisionModal {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /copy prompt/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    const written = (navigator.clipboard.writeText as any).mock.calls[0][0];
    expect(written).toContain("Re-pair: reconsider");
    expect(written).toContain("Redis");
    // Button flips to "Copied ✓"
    expect(await screen.findByText(/Copied ✓/)).toBeInTheDocument();
  });

  it("Save posts to /api/prompts with content + decisionId + sessionId", async () => {
    render(<RepairDecisionModal {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /save to/i }));
    await waitFor(() => {
      const call = (fetch as any).mock.calls.find((c: any) => c[0].includes("/api/prompts"));
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.content).toContain("Re-pair: reconsider");
      expect(body.decisionId).toBe("dec_xyz");
      expect(body.sessionId).toBe("session_abc");
    });
    // Success indicator shows the relative path
    expect(await screen.findByText(/.deeppairing\/prompts\/test.md/)).toBeInTheDocument();
  });

  it("Escape on the dialog invokes onClose", () => {
    render(<RepairDecisionModal {...baseProps} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(baseProps.onClose).toHaveBeenCalled();
  });
});
