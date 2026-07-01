import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KeyboardShortcutHelp } from "../KeyboardShortcutHelp";
import { useOverlayStore } from "../../stores/overlay";

beforeEach(() => useOverlayStore.setState({ count: 0 }));

// UM — post-useModal-migration behavior contract (was smoke-only before).
describe("KeyboardShortcutHelp — modal contract", () => {
  it("is a modal dialog and registers overlay presence (suppresses global shortcuts)", () => {
    render(<KeyboardShortcutHelp onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Keyboard shortcuts");
    expect(useOverlayStore.getState().count).toBe(1);
  });

  it("releases overlay presence on unmount", () => {
    const { unmount } = render(<KeyboardShortcutHelp onClose={() => {}} />);
    unmount();
    expect(useOverlayStore.getState().count).toBe(0);
  });

  it("closes on Escape (dispatched on the trapped-focus panel)", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutHelp onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click but NOT on panel click", () => {
    const onClose = vi.fn();
    const { container } = render(<KeyboardShortcutHelp onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog")); // panel — stopPropagation
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.firstChild as Element); // backdrop
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
