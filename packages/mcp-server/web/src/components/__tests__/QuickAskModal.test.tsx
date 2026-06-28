import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuickAskModal } from "../QuickAskModal";

describe("QuickAskModal (U3 — themed q composer, replaces window.prompt)", () => {
  it("submits the typed question via ⌘⏎ + closes; an empty question is a no-op", async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<QuickAskModal artifactTitle="Plan X" onSubmit={onSubmit} onClose={onClose} />);
    const ta = screen.getByPlaceholderText(/your question/i);

    fireEvent.keyDown(ta, { key: "Enter", metaKey: true }); // empty → no-op
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.type(ta, "why redis?");
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith("why redis?");
    expect(onClose).toHaveBeenCalled();
  });

  it("Esc closes without submitting", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<QuickAskModal artifactTitle="Plan X" onSubmit={onSubmit} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
