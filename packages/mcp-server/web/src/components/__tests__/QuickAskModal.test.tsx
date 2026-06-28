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
    await Promise.resolve(); // submit awaits onSubmit before closing
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

  it("keeps the composer open + keeps the text when the send fails (no unhandled rejection)", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("network"));
    const onClose = vi.fn();
    render(<QuickAskModal artifactTitle="Plan X" onSubmit={onSubmit} onClose={onClose} />);
    const ta = screen.getByPlaceholderText(/your question/i) as HTMLTextAreaElement;
    await userEvent.type(ta, "why redis?");
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled(); // stayed open for retry
    expect(ta.value).toBe("why redis?"); // text retained
  });

  it("focus-traps to the textarea and returns focus to the trigger on close (DD7)", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<QuickAskModal artifactTitle="Plan X" onSubmit={vi.fn()} onClose={vi.fn()} />);
    // the trap focuses the first focusable (the textarea), NOT via autoFocus
    expect((document.activeElement as HTMLElement)?.tagName).toBe("TEXTAREA");
    unmount();
    // ...and restores focus to the artifact card the user came from
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
