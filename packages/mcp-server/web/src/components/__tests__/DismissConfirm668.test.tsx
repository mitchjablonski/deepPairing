import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ArtifactStatusActions } from "../artifacts/ArtifactStatusActions";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useConnectionGraceStore } from "../../lib/connectionGrace";

/** #668 #1 — the pane's "Dismiss — overcome by new information" is two-step. */
const art = (id: string, title: string) => ({
  id, sessionId: "s1", type: "research", version: 1, parentId: null, title, status: "draft",
  content: {}, agentReasoning: null, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
}) as any;

let updateArtifactStatus: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }))));
  useArtifactStore.getState().reset();
  updateArtifactStatus = vi.fn().mockResolvedValue(undefined);
  useArtifactStore.setState({ artifacts: [art("a1", "One"), art("a2", "Two")], updateArtifactStatus } as any);
  useConnectionStore.setState({
    connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }],
    staleDaemon: false, snapshotUnavailable: false, sessionConflict: false, agentActivityAt: null, disconnectedSince: null,
  } as any);
  useConnectionGraceStore.setState({ everConnected: false, graceOver: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const dismiss = () => screen.getByRole("button", { name: "Dismiss — overcome by new information" });
const confirm = () => screen.getByRole("button", { name: /Dismiss\? \(can't be undone\)/ });

describe("#668 #1 — pane Dismiss asks before closing for good", () => {
  it("the first click only arms; nothing is written until the confirm", async () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    expect(updateArtifactStatus).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(confirm()); });
    expect(updateArtifactStatus).toHaveBeenCalledTimes(1);
    expect(updateArtifactStatus.mock.calls[0]![0]).toBe("a1");
    expect(updateArtifactStatus.mock.calls[0]![1]).toBe("obsolete");
  });

  it("Keep it backs out without writing", () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(updateArtifactStatus).not.toHaveBeenCalled();
    expect(dismiss()).toBeInTheDocument();
  });

  it("a typed reply still rides along as the reason on confirm", async () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "moved past this" } });
    fireEvent.click(dismiss());
    await act(async () => { fireEvent.click(confirm()); });
    expect(updateArtifactStatus).toHaveBeenCalledWith("a1", "obsolete", "moved past this");
  });

  it("switching to another artifact drops an armed confirm", () => {
    const { rerender } = render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    expect(confirm()).toBeInTheDocument();
    rerender(<ArtifactStatusActions artifact={art("a2", "Two")} />);
    expect(screen.queryByRole("button", { name: /Dismiss\? \(can't be undone\)/ })).toBeNull();
    expect(dismiss()).toBeInTheDocument();
  });
});
