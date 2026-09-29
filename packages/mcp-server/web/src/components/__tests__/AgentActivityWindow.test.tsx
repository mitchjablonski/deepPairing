import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { TurnIndicator } from "../TurnIndicator";
import { MessageInput } from "../MessageInput";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { AGENT_ACTIVE_WINDOW_MS } from "../../lib/agentActivity";

/**
 * #430 PR 1b (docs/design/attention-hierarchy.md §2.7 item 3, §8 PR 1b) — ONE
 * "is the agent working?" window. The header pill (TurnIndicator, was 45s) and
 * every useAgentRecentlyActive surface — here the composer's latency promise
 * "usually under 30s" (was 60s) — disagreed for 15s after each check-in: the
 * pill said "Up to date" while the composer still promised a sub-30s answer.
 * The #204 90s resume hysteresis (RequestComposerBanner) is a different
 * threshold and is untouched.
 */
beforeEach(() => {
  useArtifactStore.getState().reset();
  (window as any).__dpConnectionStore = { getState: () => useConnectionStore.getState() };
  useConnectionStore.setState({
    connected: true,
    sessionId: "s1",
    activeSessions: [{ sessionId: "s1", live: true }],
    agentActivityAt: null,
    agentActiveSince: null,
  } as any);
});
afterEach(() => {
  vi.useRealTimers();
  useConnectionStore.setState({ connected: false, sessionId: null, activeSessions: [], agentActivityAt: null } as any);
});

function surfaces() {
  const pillWorking = screen.queryByText(/agent working/i) !== null;
  const composerActive = screen.queryByText(/usually under 30s/i) !== null;
  return { pillWorking, composerActive };
}

describe("#430 PR 1b — the header pill and the composer share one activity window", () => {
  it("the window is 60s", () => {
    expect(AGENT_ACTIVE_WINDOW_MS).toBe(60_000);
  });

  it.each([44, 46, 59, 61])("a heartbeat %is ago: both surfaces say the same thing", (secondsAgo) => {
    const now = Date.now();
    useConnectionStore.setState({ agentActivityAt: now - secondsAgo * 1000, agentActiveSince: now - secondsAgo * 1000 } as any);
    render(<><TurnIndicator /><MessageInput /></>);
    const { pillWorking, composerActive } = surfaces();
    expect(pillWorking).toBe(composerActive);
    expect(pillWorking).toBe(secondsAgo < 60);
  });

  it("they flip TOGETHER when the window closes (no 15s disagreement)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const now = Date.now();
    useConnectionStore.setState({ agentActivityAt: now - 50_000, agentActiveSince: now - 50_000 } as any);
    render(<><TurnIndicator /><MessageInput /></>);
    expect(surfaces()).toEqual({ pillWorking: true, composerActive: true });
    act(() => { vi.advanceTimersByTime(8_000); }); // 58s: both still active (the old 45s pill had flipped)
    expect(surfaces()).toEqual({ pillWorking: true, composerActive: true });
    act(() => { vi.advanceTimersByTime(3_000); }); // 61s: both idle
    expect(surfaces()).toEqual({ pillWorking: false, composerActive: false });
    cleanup();
  });
});
