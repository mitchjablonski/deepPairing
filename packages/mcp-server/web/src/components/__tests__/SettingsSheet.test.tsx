import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsSheet } from "../SettingsSheet";
import { useOverlayStore } from "../../stores/overlay";

beforeEach(() => useOverlayStore.setState({ count: 0 }));

// UM — SettingsSheet gained role="dialog" + aria-modal in the useModal migration
// (it had NEITHER before, so SRs never announced it as a modal). Was smoke-only.
describe("SettingsSheet — modal contract", () => {
  it("is now an announced modal dialog (gained role + aria-modal + label)", () => {
    render(<SettingsSheet onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Settings");
    expect(useOverlayStore.getState().count).toBe(1);
  });

  it("releases overlay presence on unmount", () => {
    const { unmount } = render(<SettingsSheet onClose={() => {}} />);
    unmount();
    expect(useOverlayStore.getState().count).toBe(0);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<SettingsSheet onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click", () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsSheet onClose={onClose} />);
    // The backdrop is the first sibling; the panel is separate (not nested).
    fireEvent.click(container.querySelector(".fixed.inset-0") as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
