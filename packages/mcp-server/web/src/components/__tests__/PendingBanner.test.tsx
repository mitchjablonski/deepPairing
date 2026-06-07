import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingBanner } from "../PendingBanner";
import { useArtifactStore } from "../../stores/artifact";

const art = (over: any) =>
  ({ id: "a", type: "research", title: "t", status: "draft", version: 1, createdAt: "2026-01-01T00:00:00.000Z", content: { summary: "s", findings: [] }, ...over }) as any;

beforeEach(() => {
  useArtifactStore.getState().reset();
});

describe("PendingBanner", () => {
  it("hides when nothing is waiting", () => {
    useArtifactStore.getState().addArtifact(art({ id: "a1", status: "approved" }));
    const { container } = render(<PendingBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts drafts of all reviewable types (incl. code_change, not just decision/plan)", () => {
    useArtifactStore.getState().addArtifact(art({ id: "cc", type: "code_change", title: "edit x", status: "draft", content: { filePath: "x", changeType: "modify", before: "a", after: "b", reasoning: "r" } }));
    render(<PendingBanner />);
    expect(screen.getByText(/1 item waiting for you/i)).toBeInTheDocument();
  });

  it("a draft's quick Dismiss marks it obsolete via the store", async () => {
    useArtifactStore.getState().addArtifact(art({ id: "d1", type: "decision", title: "pick a cache", status: "draft", content: { context: "x", options: [], decisionId: "dec" } }));
    const spy = vi.spyOn(useArtifactStore.getState(), "updateArtifactStatus").mockResolvedValue();
    render(<PendingBanner />);
    await userEvent.click(screen.getByRole("button", { name: /dismiss pick a cache/i }));
    expect(spy).toHaveBeenCalledWith("d1", "obsolete");
  });
});
