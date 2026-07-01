import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "../CommandPalette";
import { useArtifactStore } from "../../stores/artifact";
import { useOverlayStore } from "../../stores/overlay";

const art = (over: any) =>
  ({ id: "a", type: "research", title: "t", status: "draft", version: 1, createdAt: "2026-01-01T00:00:00.000Z", content: {}, ...over }) as any;

beforeEach(() => {
  useArtifactStore.getState().reset();
});

describe("CommandPalette — F2 'Approve all' excludes decisions", () => {
  it("approves non-decision drafts but SKIPS decisions (a blanket approve records no optionId)", async () => {
    useArtifactStore.getState().addArtifact(art({ id: "p1", type: "plan", title: "Ship it", content: { steps: [], estimatedChanges: 0 } }));
    useArtifactStore.getState().addArtifact(art({ id: "d1", type: "decision", title: "pick a store", content: { context: "?", options: [], decisionId: "dec" } }));
    const spy = vi.spyOn(useArtifactStore.getState(), "updateArtifactStatus").mockResolvedValue();

    render(<CommandPalette onClose={() => {}} />);
    await userEvent.click(screen.getByText(/approve all draft artifacts/i));

    await waitFor(() => expect(spy).toHaveBeenCalledWith("p1", "approved"));
    // the decision must NOT be blanket-approved (it needs an explicit optionId via the card)
    expect(spy).not.toHaveBeenCalledWith("d1", "approved");
  });
});

describe("CommandPalette — modal contract (useModal migration, UM2)", () => {
  it("is a modal dialog and registers overlay presence", () => {
    useOverlayStore.setState({ count: 0 });
    render(<CommandPalette onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(useOverlayStore.getState().count).toBe(1);
  });

  it("Escape on the search INPUT bubbles to the panel and closes (the exact path UM2 relies on)", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    // Post-migration the input's handler no longer handles Esc; it must bubble to
    // the panel's dialogProps.onKeyDown. Fire on the input, not the panel.
    fireEvent.keyDown(screen.getByPlaceholderText(/search artifacts/i), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Arrow keys on the input are still handled by the custom nav (don't close/throw)", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search artifacts/i);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
