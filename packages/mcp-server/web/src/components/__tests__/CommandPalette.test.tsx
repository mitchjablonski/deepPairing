import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "../CommandPalette";
import { useArtifactStore } from "../../stores/artifact";

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
