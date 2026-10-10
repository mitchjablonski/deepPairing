import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import App from "../../App";

const { FakeAdapter, adapters } = vi.hoisted(() => {
  class FakeAdapter {
    connectHandler: (() => void) | null = null;
    disconnectHandler: (() => void) | null = null;
    messageHandler: ((message: unknown) => void) | null = null;
    fatalHandler: (() => void) | null = null;
    refusalHandler: ((info: { code: string; sessionId: string }) => void) | null = null;
    switched: string[] = [];
    onConnect(h: () => void) { this.connectHandler = h; }
    onDisconnect(h: () => void) { this.disconnectHandler = h; }
    onMessage(h: (message: unknown) => void) { this.messageHandler = h; }
    onFatalMismatch(h: () => void) { this.fatalHandler = h; }
    onConnectionRefused(h: (info: { code: string; sessionId: string }) => void) { this.refusalHandler = h; }
    connect() { this.connectHandler?.(); }
    disconnect() { this.disconnectHandler?.(); }
    switchSession(id: string) { this.switched.push(id); }
    emit(message: unknown) { this.messageHandler?.(message); }
  }
  return { FakeAdapter, adapters: [] as FakeAdapter[] };
});
vi.mock("../../lib/connection-adapter", () => ({ createAdapter: () => {
  const adapter = new FakeAdapter();
  adapters.push(adapter);
  return adapter;
} }));
import { useConnectionStore, selectHydratedForBinding } from "../../stores/connection";
import { useArtifactStore } from "../../stores/artifact";
import { useToastStore } from "../../stores/toast";
import { useConnectionGraceDriver, useConnectionGraceStore, HYDRATION_STALL_MS } from "../../lib/connectionGrace";

function Driver() { useConnectionGraceDriver(); return null; }
const current = () => adapters.at(-1)!;
const ready = () => selectHydratedForBinding(useConnectionStore.getState());
const snapshot = (sessionId: string) => ({ type: "connected", projectRoot: "/project", state: {
  sessionId,
  artifacts: [{ id: `${sessionId}-artifact`, sessionId, type: "research", version: 1, parentId: null, title: sessionId, status: "draft", content: { summary: sessionId, findings: [] }, agentReasoning: null, createdAt: "now", updatedAt: "now" }],
  comments: [], requests: [], decisions: [],
} });
async function navigate(id: string, preserveStateUntilConnected = false) {
  act(() => useConnectionStore.getState().switchSession(id, { preserveStateUntilConnected }));
  await vi.waitFor(() => expect(current().switched).toContain(id));
}
async function appliedA() {
  render(<Driver />);
  act(() => useConnectionStore.getState().connect("A"));
  act(() => current().emit(snapshot("A")));
  await vi.waitFor(() => expect(useArtifactStore.getState().artifacts).toHaveLength(1));
  expect(ready()).toBe(true);
  vi.useFakeTimers();
}
beforeEach(() => {
  useConnectionStore.getState().disconnect();
  adapters.length = 0;
  useConnectionStore.setState({ connected: false, hydrated: false, hydratedBinding: null, sessionId: null, projectRoot: null, activeSessions: [], staleDaemon: false, snapshotUnavailable: false, sessionConflict: false });
  useConnectionGraceStore.setState({ everConnected: false, graceOver: false, hydrationStalled: false });
  useArtifactStore.getState().reset();
  useToastStore.getState().dismissAll();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 })));
});
afterEach(() => {
  useConnectionStore.getState().disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("applied hydration evidence belongs to a retained frame, not just a reusable binding key", () => {
  it("A applied -> B reset -> A without a new snapshot offers recovery instead of reviving readiness", async () => {
    await appliedA();
    await navigate("B");
    await navigate("A");
    expect(useArtifactStore.getState().artifacts).toEqual([]);
    expect(ready()).toBe(false);
    act(() => vi.advanceTimersByTime(HYDRATION_STALL_MS + 1));
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(true);
    await act(async () => current().emit(snapshot("A")));
    await vi.waitFor(() => expect(ready()).toBe(true));
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(false);
  });

  it("explicit teardown -> fresh adapter without a snapshot must earn readiness again", async () => {
    await appliedA();
    const old = current();
    act(() => useConnectionStore.getState().disconnect());
    expect(ready()).toBe(false);
    act(() => useConnectionStore.getState().connect("A"));
    expect(current()).not.toBe(old);
    act(() => vi.advanceTimersByTime(HYDRATION_STALL_MS + 1));
    expect(ready()).toBe(false);
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(true);
    expect(useArtifactStore.getState().artifacts.map((artifact) => artifact.id)).toEqual(["A-artifact"]);
  });

  it("fresh different-session binding cannot reveal the previous frame after its snapshot stalls", async () => {
    await appliedA();
    act(() => useConnectionStore.getState().disconnect());
    act(() => useConnectionStore.getState().connect("B"));
    render(<App />);
    expect(useConnectionStore.getState().sessionId).toBe("B");
    expect(ready()).toBe(false);
    act(() => vi.advanceTimersByTime(HYDRATION_STALL_MS + 1));
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(true);
    expect(screen.getByTestId("hydration-unknown")).toBeInTheDocument();
    expect(useArtifactStore.getState().artifacts).toEqual([]);
    expect(screen.getByRole("main").querySelector('[data-artifact-id="A-artifact"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /^Send$/ })).not.toBeInTheDocument();
  });

  it("frame retirement precedes a fast fresh snapshot and queued old callbacks cannot erase it", async () => {
    await appliedA();
    const old = current();
    await act(async () => {
      old.emit(snapshot("A"));
      useConnectionStore.getState().disconnect();
      useConnectionStore.getState().connect("B");
      expect(useArtifactStore.getState().artifacts).toEqual([]);
      current().emit(snapshot("B"));
    });
    await vi.waitFor(() => expect(ready()).toBe(true));
    expect(useConnectionStore.getState().sessionId).toBe("B");
    expect(useArtifactStore.getState().artifacts.map((artifact) => artifact.id)).toEqual(["B-artifact"]);
    act(() => vi.advanceTimersByTime(HYDRATION_STALL_MS + 1));
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(false);
  });

  it("ordinary same-adapter socket reconnect preserves its actual loaded frame", async () => {
    await appliedA();
    act(() => current().disconnect());
    act(() => current().connect());
    act(() => vi.advanceTimersByTime(HYDRATION_STALL_MS + 1));
    expect(ready()).toBe(true);
    expect(useArtifactStore.getState().artifacts.map((artifact) => artifact.id)).toEqual(["A-artifact"]);
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(false);
  });

  it("a same-session semantic reset also retires the discarded frame's evidence", async () => {
    await appliedA();
    await navigate("A");
    expect(useArtifactStore.getState().artifacts).toEqual([]);
    expect(ready()).toBe(false);
    act(() => vi.advanceTimersByTime(HYDRATION_STALL_MS + 1));
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(true);
  });

  it("deliberate frame-preserving switches keep evidence only for the actual retained binding", async () => {
    await appliedA();
    await navigate("B", true);
    expect(ready()).toBe(false);
    expect(useArtifactStore.getState().artifacts.map((artifact) => artifact.id)).toEqual(["A-artifact"]);
    await navigate("A", true);
    act(() => vi.advanceTimersByTime(HYDRATION_STALL_MS + 1));
    expect(ready()).toBe(true);
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(false);
  });

  it("obsolete adapter callbacks cannot hydrate, disconnect or refuse a fresh binding", async () => {
    await appliedA();
    const old = current();
    act(() => useConnectionStore.getState().disconnect());
    act(() => useConnectionStore.getState().connect("B"));
    expect(useConnectionStore.getState().sessionId).toBe("B");
    await act(async () => {
      old.connect();
      old.emit(snapshot("B"));
      old.disconnect();
      old.fatalHandler?.();
      old.refusalHandler?.({ code: "session_review_conflict", sessionId: "B" });
    });
    expect(useConnectionStore.getState()).toMatchObject({ connected: true, sessionId: "B", hydrated: false, staleDaemon: false, snapshotUnavailable: false, sessionConflict: false });
    expect(useToastStore.getState().toasts).toEqual([]);
    act(() => vi.advanceTimersByTime(HYDRATION_STALL_MS + 1));
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(true);
    await act(async () => current().emit(snapshot("B")));
    await vi.waitFor(() => expect(ready()).toBe(true));
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(false);
  });
});
