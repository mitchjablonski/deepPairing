import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useModal } from "../useModal";
import { useOverlayStore } from "../../stores/overlay";

function Harness({ onClose, active }: { onClose: () => void; active?: boolean }) {
  const { dialogProps } = useModal({ onClose, active });
  return (
    <div {...dialogProps} aria-label="test modal">
      <button type="button">first</button>
      <button type="button">second</button>
    </div>
  );
}

beforeEach(() => useOverlayStore.setState({ count: 0 }));

describe("useModal", () => {
  it("marks the panel as a modal dialog (role + aria-modal)", () => {
    render(<Harness onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("tabindex", "-1");
  });

  it("registers as an overlay while active (suppresses global shortcuts) and releases on unmount", () => {
    const { unmount } = render(<Harness onClose={() => {}} />);
    expect(useOverlayStore.getState().count).toBe(1);
    unmount();
    expect(useOverlayStore.getState().count).toBe(0);
  });

  it("does NOT register when inactive", () => {
    render(<Harness onClose={() => {}} active={false} />);
    expect(useOverlayStore.getState().count).toBe(0);
  });

  it("traps focus into the panel on open", () => {
    render(<Harness onClose={() => {}} />);
    // useFocusTrap moves focus to the first focusable inside the dialog.
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the trigger on unmount", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(<Harness onClose={() => {}} />);
    expect(document.activeElement).not.toBe(trigger); // focus moved into the dialog
    unmount();
    expect(document.activeElement).toBe(trigger); // …and restored on close

    trigger.remove();
  });
});
