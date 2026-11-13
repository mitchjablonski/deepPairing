import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextPendingLink } from "../NextPendingLink";
import { useArtifactStore } from "../../stores/artifact";
import { useReplayStore } from "../../stores/replay";

let t = 0;
const at = () => `2026-06-01T00:${String(t++).padStart(2, "0")}:00.000Z`;
const art = (id: string, title: string, over: Record<string, unknown> = {}) =>
  ({ id, type: "plan", title, status: "draft", version: 1, createdAt: at(), content: { summary: "s", steps: [] }, ...over }) as any;

beforeEach(() => {
  useArtifactStore.getState().reset();
  useReplayStore.setState({ active: false } as any);
});

describe("NextPendingLink (#642 item 7)", () => {
  it("on a resolved artifact, names the head of the pending queue and opens it on click (no auto-jump)", () => {
    const done = art("done", "Approved plan", { status: "approved" });
    useArtifactStore.setState({ artifacts: [done, art("p1", "First waiting"), art("p2", "Second waiting")], selectedArtifactId: "done" } as any);
    render(<NextPendingLink artifact={done} />);
    // Rendering alone moves nothing.
    expect(useArtifactStore.getState().selectedArtifactId).toBe("done");
    const link = screen.getByRole("button", { name: "Next waiting for you: First waiting, 1 more after it" });
    expect(link).toHaveTextContent("Next: First waiting →");
    fireEvent.click(link);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("p1");
  });

  it("is absent while the artifact on screen is itself waiting on you", () => {
    const p1 = art("p1", "First waiting");
    useArtifactStore.setState({ artifacts: [p1, art("p2", "Second waiting")], selectedArtifactId: "p1" } as any);
    render(<NextPendingLink artifact={p1} />);
    expect(screen.queryByRole("button", { name: /next waiting for you/i })).toBeNull();
  });

  it("is absent when nothing else is waiting, and during replay", () => {
    const done = art("done", "Approved plan", { status: "approved" });
    useArtifactStore.setState({ artifacts: [done], selectedArtifactId: "done" } as any);
    const { unmount } = render(<NextPendingLink artifact={done} />);
    expect(screen.queryByRole("button", { name: /next waiting for you/i })).toBeNull();
    unmount();
    useArtifactStore.setState({ artifacts: [done, art("p1", "First waiting")] } as any);
    useReplayStore.setState({ active: true } as any);
    render(<NextPendingLink artifact={done} />);
    expect(screen.queryByRole("button", { name: /next waiting for you/i })).toBeNull();
  });
});
