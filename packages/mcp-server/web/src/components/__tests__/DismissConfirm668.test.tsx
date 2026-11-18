import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ArtifactStatusActions } from "../artifacts/ArtifactStatusActions";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useConnectionGraceStore } from "../../lib/connectionGrace";

/** #668 #1 — the pane's "Dismiss — overcome by new information" is two-step. */
const art = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: "s1", type: "research", version: 1, parentId: null, title, status: "draft",
  content: {}, agentReasoning: null, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", ...over,
}) as any;

let updateArtifactStatus: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const dismiss = () => screen.getByRole("button", { name: "Dismiss — overcome by new information" });
const confirm = () => screen.getByRole("button", { name: /Dismiss\? \(can't be undone\)/ });
const keep = () => screen.getByRole("button", { name: "Keep it" });
const settle = () => act(() => { vi.advanceTimersByTime(450); });

describe("#668 #1 — pane Dismiss asks before closing for good", () => {
  it("arming moves focus to Keep it; nothing is written until a deliberate confirm", async () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    expect(document.activeElement).toBe(keep());
    expect(updateArtifactStatus).not.toHaveBeenCalled();
    settle();
    await act(async () => { fireEvent.click(confirm()); });
    expect(updateArtifactStatus).toHaveBeenCalledTimes(1);
    expect(updateArtifactStatus.mock.calls[0]![0]).toBe("a1");
    expect(updateArtifactStatus.mock.calls[0]![1]).toBe("obsolete");
  });

  it("a rapid repeat right after arming cannot commit (the confirm is inert for a beat)", async () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    await act(async () => { fireEvent.click(confirm()); }); // immediate second activation
    expect(updateArtifactStatus).not.toHaveBeenCalled();
    expect(confirm()).toBeDisabled();
  });

  it("Keep it backs out without writing and returns focus to the trigger", () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    fireEvent.click(keep());
    expect(updateArtifactStatus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(dismiss());
  });

  it("Escape cancels from the keyboard and restores focus", () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    fireEvent.keyDown(keep(), { key: "Escape" });
    expect(screen.queryByRole("button", { name: /Dismiss\? \(can't be undone\)/ })).toBeNull();
    expect(document.activeElement).toBe(dismiss());
    expect(updateArtifactStatus).not.toHaveBeenCalled();
  });

  it("keyboard confirm: Tab-reachable and Enter-activatable once ready", async () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    settle();
    confirm().focus();
    await act(async () => { fireEvent.click(confirm()); }); // Enter on a <button> dispatches click
    expect(updateArtifactStatus).toHaveBeenCalledTimes(1);
  });

  it("a typed reply is announced and rides along as the reason; cancel keeps the text", async () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "moved past this" } });
    fireEvent.click(dismiss());
    expect(screen.getByTestId("dismiss-note-hint")).toHaveTextContent("Your note is sent as the reason.");
    fireEvent.click(keep());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("moved past this");
    fireEvent.click(dismiss());
    settle();
    await act(async () => { fireEvent.click(confirm()); });
    expect(updateArtifactStatus).toHaveBeenCalledWith("a1", "obsolete", "moved past this");
  });

  it("a failed write keeps the typed text for a retry", async () => {
    updateArtifactStatus.mockRejectedValueOnce(new Error("boom"));
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep me" } });
    fireEvent.click(dismiss());
    settle();
    await act(async () => { fireEvent.click(confirm()); });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep me");
    expect(dismiss()).toBeInTheDocument();
  });

  it("disarms on a pane switch, a binding change, or a same-id eligibility change", () => {
    const { rerender } = render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    rerender(<ArtifactStatusActions artifact={art("a2", "Two")} />);
    expect(screen.queryByRole("button", { name: /Dismiss\? \(can't be undone\)/ })).toBeNull();

    fireEvent.click(dismiss());
    act(() => { useConnectionStore.setState({ sessionId: "s2" } as any); });
    expect(screen.queryByRole("button", { name: /Dismiss\? \(can't be undone\)/ })).toBeNull();

    fireEvent.click(dismiss());
    rerender(<ArtifactStatusActions artifact={art("a2", "Two", { version: 2 })} />);
    expect(screen.queryByRole("button", { name: /Dismiss\? \(can't be undone\)/ })).toBeNull();
  });

  it("commit rechecks the live store: an artifact no longer draft is not dismissed", async () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    settle();
    act(() => { useArtifactStore.setState({ artifacts: [art("a1", "One", { status: "approved" })] } as any); });
    await act(async () => { fireEvent.click(confirm()); });
    expect(updateArtifactStatus).not.toHaveBeenCalled();
  });

  it("arming cancels an armed approve countdown, so it can't resolve the artifact meanwhile", () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    act(() => {
      window.dispatchEvent(new CustomEvent("dp:artifact-shortcut", { detail: { artifactId: "a1", action: "approve" } }));
    });
    expect(screen.getByText(/in 3s/)).toBeInTheDocument();
    fireEvent.click(dismiss());
    expect(screen.queryByText(/in 3s/)).toBeNull();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(updateArtifactStatus).not.toHaveBeenCalled();
    const statusPosts = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes("/status"));
    expect(statusPosts).toHaveLength(0);
  });
});

describe("Sol (#670) follow-up — exclusive verdicts and armed identity", () => {
  it("while Dismiss is armed, `a` and empty ⌘⏎ start no approve countdown", () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    act(() => {
      window.dispatchEvent(new CustomEvent("dp:artifact-shortcut", { detail: { artifactId: "a1", action: "approve" } }));
    });
    expect(screen.queryByText(/in 3s/)).toBeNull();
    fireEvent.click(keep()); // back out, then try ⌘⏎ with the confirm open again
    fireEvent.click(dismiss());
    // The textarea is still in the footer; empty ⌘⏎ must not arm while confirming.
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
    expect(screen.queryByText(/in 3s/)).toBeNull();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(updateArtifactStatus).not.toHaveBeenCalled();
  });

  it("the destructive confirm is on its own row, not the trigger's line", () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    const row = screen.getByTestId("dismiss-confirm-row");
    expect(row).toContainElement(confirm());
    expect(row).not.toContainElement(keep());
  });

  it("the write checks the armed version and binding, not just live status", async () => {
    render(<ArtifactStatusActions artifact={art("a1", "One")} />);
    fireEvent.click(dismiss());
    settle();
    // Same id and still draft, but a newer version landed in the store.
    act(() => { useArtifactStore.setState({ artifacts: [art("a1", "One", { version: 2 })] } as any); });
    await act(async () => { fireEvent.click(confirm()); });
    expect(updateArtifactStatus).not.toHaveBeenCalled();
  });
});
