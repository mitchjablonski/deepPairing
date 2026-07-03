import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "../CommandPalette";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
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
    await userEvent.click(screen.getByText(/approve all \d+ draft artifacts?/i));

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

describe("E3 (L3) — content search", () => {
  it("matches artifact CONTENT by substring; schema keys never match", async () => {
    useArtifactStore.setState({
      artifacts: [
        art({ id: "a1", title: "Cache design", content: { summary: "we should use exponential backoff for the retry policy" } }),
        art({ id: "a2", title: "Unrelated", content: { summary: "nothing relevant here" } }),
      ],
    });
    render(<CommandPalette onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: "retry policy" } });
    expect(await screen.findByText("Cache design")).toBeInTheDocument();
    expect(screen.queryByText("Unrelated")).toBeNull();

    // Schema KEYS must not match: 'summary' is a key on BOTH artifacts but
    // content of neither. (JSON.stringify-based haystacks failed this.)
    fireEvent.change(input, { target: { value: "summary" } });
    expect(screen.queryByText("Cache design")).toBeNull();
    expect(screen.queryByText("Unrelated")).toBeNull();
  });
});

describe("F9 (L7) — approve-all scopes to the bound session and discloses", () => {
  it("only this session's drafts are approved; the label carries scope + count", async () => {
    useConnectionStore.setState({ sessionId: "s1" } as any);
    const mk = (id: string, sessionId: string) =>
      ({ id, sessionId, type: "research", version: 1, parentId: null, title: id,
         status: "draft", content: {}, agentReasoning: null,
         createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }) as any;
    useArtifactStore.setState({ artifacts: [mk("mine", "s1"), mk("foreign", "s2")] });
    const calls: string[] = [];
    useArtifactStore.setState({
      updateArtifactStatus: (async (id: string) => { calls.push(id); }) as any,
    });
    render(<CommandPalette onClose={() => {}} />);
    const item = await screen.findByText(/Approve all 1 draft artifact in this session/);
    fireEvent.click(item);
    await waitFor(() => expect(calls).toEqual(["mine"]));
  });
});
