import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReplayScrubber } from "../ReplayScrubber";
import { useReplayStore } from "../../stores/replay";
import type { Artifact } from "@deeppairing/shared";

function artifact(id: string, createdAt: string): Artifact {
  return {
    id,
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: `Artifact ${id}`,
    status: "draft",
    content: {},
    agentReasoning: null,
    createdAt,
    updatedAt: createdAt,
  };
}

const state = {
  artifacts: [
    artifact("a1", "2026-04-17T10:00:00.000Z"),
    artifact("a2", "2026-04-17T10:05:00.000Z"),
    artifact("a3", "2026-04-17T10:10:00.000Z"),
  ],
};

beforeEach(async () => {
  useReplayStore.getState().exitReplay();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ annotations: [] }),
  }));
  await useReplayStore.getState().enterReplay("session_abc", state);
});

describe("ReplayScrubber", () => {
  it("does not render when replay is inactive", () => {
    useReplayStore.getState().exitReplay();
    const { container } = render(<ReplayScrubber />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows events count and mode label", () => {
    render(<ReplayScrubber />);
    expect(screen.getByText(/Replay mode/i)).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 3 events/i)).toBeInTheDocument();
  });

  it("Step forward advances the cursor", async () => {
    render(<ReplayScrubber />);
    const before = useReplayStore.getState().cursor;
    await userEvent.click(screen.getByRole("button", { name: /Step forward/i }));
    expect(useReplayStore.getState().cursor).not.toBe(before);
  });

  it("Step backward after advancing returns toward the start", async () => {
    render(<ReplayScrubber />);
    await userEvent.click(screen.getByRole("button", { name: /Step forward/i }));
    await userEvent.click(screen.getByRole("button", { name: /Step forward/i }));
    const forward = useReplayStore.getState().cursor;
    await userEvent.click(screen.getByRole("button", { name: /Step backward/i }));
    expect(useReplayStore.getState().cursor < forward).toBe(true);
  });

  it("Play toggles to Pause and sets playing=true", async () => {
    render(<ReplayScrubber />);
    await userEvent.click(screen.getByRole("button", { name: /^▶ Play$/ }));
    expect(useReplayStore.getState().playing).toBe(true);
    expect(screen.getByRole("button", { name: /Pause/i })).toBeInTheDocument();
    // Pause for cleanup so the interval timer doesn't keep firing
    await userEvent.click(screen.getByRole("button", { name: /Pause/i }));
  });

  it("Speed selector updates the speed state", async () => {
    render(<ReplayScrubber />);
    await userEvent.click(screen.getByRole("button", { name: /^16x$/ }));
    expect(useReplayStore.getState().speed).toBe(16);
  });

  it("Exit button clears replay mode", async () => {
    render(<ReplayScrubber />);
    await userEvent.click(screen.getByRole("button", { name: /^Exit$/ }));
    expect(useReplayStore.getState().active).toBe(false);
  });

  it("📝 note button + input saves an annotation via POST", async () => {
    render(<ReplayScrubber />);
    await userEvent.click(screen.getByRole("button", { name: /📝 note/i }));
    const input = screen.getByPlaceholderText(/Note to future-you/i);
    await userEvent.type(input, "push back on perf framing");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      const calls = (fetch as any).mock.calls;
      const annCall = calls.find((c: any) =>
        c[0].includes("/api/sessions/session_abc/annotations") && c[1]?.method === "POST",
      );
      expect(annCall).toBeDefined();
      const body = JSON.parse(annCall[1].body);
      expect(body.note).toBe("push back on perf framing");
      expect(body.targetEventId).toBeTruthy();
    });
  });
});
