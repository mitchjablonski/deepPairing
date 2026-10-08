import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * #487 review (Sol, exact-head probes at 666e2caf) — ported as regressions.
 *
 *  1. The hydration watchdog is scoped to the CURRENT binding: a real A
 *     snapshot, switchSession(B), a transport reconnect and no B snapshot must
 *     still surface recovery after the deadline (B must not inherit A's
 *     applied state). Positive control: a real snapshot clears the deadline.
 *  2. Unknown ≠ known-empty: connected with no snapshot past the deadline, the
 *     main area must not claim "Waiting for Claude".
 *  3. RequestComposer completion fence: an old POST that succeeds after
 *     A→B→A with a replaced draft must not clear, close or announce.
 */
const { FakeAdapter, adapters } = vi.hoisted(() => {
  const adapters: any[] = [];
  class FakeAdapter {
    messageHandler: ((d: any) => void) | null = null;
    connectHandler: (() => void) | null = null;
    disconnectHandler: (() => void) | null = null;
    switched: string[] = [];
    connect() { this.connectHandler?.(); }
    disconnect() { this.disconnectHandler?.(); }
    onMessage(h: (d: any) => void) { this.messageHandler = h; }
    onConnect(h: () => void) { this.connectHandler = h; }
    onDisconnect(h: () => void) { this.disconnectHandler = h; }
    refreshUrl() {}
    onFatalMismatch() {}
    onConnectionRefused() {}
    retryAfterRefusal() {}
    switchSession(sid: string) { this.switched.push(sid); }
    emit(d: any) { this.messageHandler?.(d); }
  }
  return { FakeAdapter, adapters };
});
vi.mock("../../lib/connection-adapter", () => ({
  createAdapter: () => { const a = new FakeAdapter(); adapters.push(a); return a; },
}));

import App from "../../App";
import { RequestComposerBanner, OPEN_REQUEST_COMPOSER_EVENT } from "../RequestComposerBanner";
import { useConnectionStore } from "../../stores/connection";
import { useArtifactStore, artifactStoreGeneration } from "../../stores/artifact";
import { useToastStore } from "../../stores/toast";
import { usePreferencesStore } from "../../stores/preferences";
import { useConnectionGraceDriver, useConnectionGraceStore, HYDRATION_STALL_MS } from "../../lib/connectionGrace";

const snapshot = (sessionId: string) => ({ type: "connected", state: { sessionId, artifacts: [], comments: [], requests: [], decisions: [] } });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); });
const adapter = () => adapters[adapters.length - 1];

function Driver() {
  useConnectionGraceDriver();
  return null;
}

beforeEach(() => {
  adapters.length = 0;
  useConnectionStore.getState().disconnect();
  useConnectionStore.setState({ connected: false, hydrated: false, hydratedBinding: null, sessionId: null, activeSessions: [], disconnectedSince: null } as any);
  useConnectionGraceStore.setState({ everConnected: false, graceOver: false, hydrationStalled: false });
  useArtifactStore.getState().reset();
  useToastStore.getState().dismissAll();
  usePreferencesStore.setState({ nextUpBar: false } as any);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))));
});
afterEach(() => {
  useConnectionStore.getState().disconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { sessionStorage.clear(); } catch { /* private mode */ }
});

describe("1 — the hydration watchdog belongs to the current binding", () => {
  it("positive control: a real complete snapshot clears the initial-binding deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Driver />);
    act(() => useConnectionStore.getState().connect("A"));
    act(() => adapter().connect());
    act(() => adapter().emit(snapshot("A")));
    await tick();
    act(() => { vi.advanceTimersByTime(HYDRATION_STALL_MS + 1); });
    expect(useConnectionStore.getState().hydrated).toBe(true);
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(false);
  });

  it("A snapshot → switchSession(B) → reconnect with no B snapshot → recovery after the deadline (B doesn't inherit A)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Driver />);
    act(() => useConnectionStore.getState().connect("A"));
    act(() => adapter().connect());
    act(() => adapter().emit(snapshot("A")));
    await tick();
    act(() => useConnectionStore.getState().switchSession("B"));
    await tick();
    act(() => { adapter().disconnect(); adapter().connect(); });
    await tick();
    act(() => { vi.advanceTimersByTime(HYDRATION_STALL_MS + 1); });
    const s = useConnectionStore.getState();
    expect(s.sessionId).toBe("B");
    expect(s.connected).toBe(true);
    // Recovery is offered for B (it was false: B inherited A's hydrated:true).
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(true);
  });

  it("an ordinary SAME-binding reconnect keeps its applied-state evidence (no false recovery)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Driver />);
    act(() => useConnectionStore.getState().connect("A"));
    act(() => adapter().connect());
    act(() => adapter().emit(snapshot("A")));
    await tick();
    act(() => { adapter().disconnect(); adapter().connect(); });
    act(() => { vi.advanceTimersByTime(HYDRATION_STALL_MS + 1); });
    expect(useConnectionStore.getState().hydrated).toBe(true);
    expect(useConnectionGraceStore.getState().hydrationStalled).toBe(false);
  });
});

describe("2 — unknown is not known-empty", () => {
  it("connected, no snapshot past the deadline: main says still-loading, never 'Waiting for Claude'", () => {
    vi.useFakeTimers({ now: Date.now() });
    useConnectionStore.setState({ connected: true, hydrated: false, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }] } as any);
    render(<App />);
    act(() => { vi.advanceTimersByTime(4100); }); // past the old 4s known-empty fall-through
    expect(screen.queryByText(/Waiting for Claude/)).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(HYDRATION_STALL_MS); });
    expect(screen.queryByText(/Waiting for Claude/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open Claude Code in this project/)).not.toBeInTheDocument();
    expect(screen.getByTestId("hydration-unknown")).toHaveTextContent(/Still loading the current state/);
  });
});

describe("3 — a stale request completion doesn't clear, close or announce", () => {
  it("deferred POST in A → A→B→A → draft replaced → old success: text kept, composer kept, no 'Saved'/'Sent', busy released", async () => {
    let resolvePost!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("/api/requests") && init?.method === "POST") {
        return new Promise<Response>((r) => { resolvePost = r; });
      }
      return Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }));
    act(() => useConnectionStore.getState().connect("A"));
    act(() => adapter().connect());
    act(() => adapter().emit(snapshot("A")));
    await tick();
    useConnectionStore.setState({ activeSessions: [{ sessionId: "A", live: false }] } as any);
    render(<RequestComposerBanner />);
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_REQUEST_COMPOSER_EVENT)); });
    const box = () => screen.getByRole("textbox", { name: "Your request to Claude" }) as HTMLInputElement;
    fireEvent.change(box(), { target: { value: "Explain the cache" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    const genAtSend = artifactStoreGeneration();

    act(() => useConnectionStore.getState().switchSession("B"));
    await waitFor(() => expect(artifactStoreGeneration()).toBeGreaterThan(genAtSend));
    act(() => useConnectionStore.getState().switchSession("A"));
    await tick();
    fireEvent.change(box(), { target: { value: "Actually: plan the limiter" } });

    await act(async () => {
      resolvePost(new Response(JSON.stringify({ request: { id: "req_old", text: "Explain the cache", intent: "explain", createdAt: new Date().toISOString() } }), { status: 200, headers: { "Content-Type": "application/json" } }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useArtifactStore.getState().requests).toEqual([]); // the store's own fence
    expect(screen.getByTestId("request-composer")).toBeInTheDocument();
    expect(box().value).toBe("Actually: plan the limiter");
    expect(useToastStore.getState().toasts.some((t) => /Saved|Sent to Claude/.test(t.title))).toBe(false);
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
  });
});
