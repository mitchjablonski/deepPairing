import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LineComposer } from "../LineComments";
import { useArtifactStore } from "../../stores/artifact";

beforeEach(() => {
  useArtifactStore.getState().reset();
});

describe("LineComposer — UX7d resilient submit", () => {
  it("re-enables the composer + keeps the text when submit fails (was stuck disabled forever)", async () => {
    vi.spyOn(useArtifactStore.getState(), "submitComment").mockRejectedValue(new Error("network"));
    const onClose = vi.fn();
    render(
      <LineComposer lineNum={1} artifactId="art_1" mode="comment" setMode={() => {}} existingComments={[]} onClose={onClose} />,
    );
    const input = screen.getByPlaceholderText(/add a comment on this line/i);
    await userEvent.type(input, "why this?");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true }); // ⌘⏎ submit

    // pre-fix: submitting stayed true forever (composer permanently disabled) and
    // onClose was unreachable. Now: stays open, re-enables, keeps the draft.
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(input).not.toBeDisabled());
    expect((input as HTMLInputElement).value).toBe("why this?");
  });
});
