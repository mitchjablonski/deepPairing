import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import App from "../../App";
import { NextUpBar } from "../NextUpBar";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";

/**
 * #457 — the §9 walkthrough defects (docs/design/attention-walkthroughs.md).
 * D4 (the HELD line), D1 (TurnIndicator silent on mount) and state G's
 * "(last known)" are pinned where those surfaces are already tested
 * (NextUpBar.test.tsx F/G, NextUpBarAbsorb.test.tsx).
 */
let t = 0;
const at = () => `2026-06-01T00:${String(t++).padStart(2, "0")}:00.000Z`;
const art = (id: string, type: string, title: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: "s1", type, version: 1, parentId: null, title, status: "draft",
  content: {}, agentReasoning: null, createdAt: at(), updatedAt: at(), ...over,
}) as any;
const plan = (id: string, title: string, steps = 4) =>
  art(id, "plan", title, { content: { steps: Array.from({ length: steps }, (_, i) => ({ description: `s${i}`, reasoning: "r" })) } });
const question = (id: string, artifactId: string) => ({
  id, sessionId: "s1", target: { artifactId }, parentCommentId: null, author: "human",
  content: `Question ${id}?`, acknowledged: false, createdAt: at(), intent: "question",
}) as any;

beforeEach(() => {
  t = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))));
  useArtifactStore.getState().reset();
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any);
  useReplayStore.setState({ active: false } as any);
  useConnectionStore.setState({
    connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }],
    staleDaemon: false, snapshotUnavailable: false, sessionConflict: false, agentActivityAt: null, disconnectedSince: null,
  } as any);
  usePreferencesStore.setState({ nextUpBar: true } as any);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const barText = () => screen.getByTestId("next-up-bar").textContent ?? "";
const announcer = () => screen.getByTestId("next-up-announcer").textContent;

describe("#457 D3 — a blocking review's 'after' never promises an absent agent", () => {
  it("live: the plan copy is unchanged", () => {
    useArtifactStore.setState({ artifacts: [plan("p1", "Backfill plan")] });
    render(<NextUpBar />);
    expect(barText()).toContain("Approve → Claude executes 4 steps");
  });

  it.each([
    ["exited", () => useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: false }] } as any), /Claude acts on your verdict when the session resumes/],
    ["disconnected", () => useConnectionStore.setState({ connected: false, disconnectedSince: Date.now() } as any), /This tab is offline — your response can be sent once it reconnects/],
    ["replaying", () => useReplayStore.setState({ active: true } as any), /Replay is read-only/],
  ])("%s: no 'Claude executes N steps'", (_name, arrange, expected) => {
    useArtifactStore.setState({ artifacts: [plan("p1", "Backfill plan")] });
    arrange();
    render(<NextUpBar />);
    expect(barText()).not.toContain("Claude executes");
    expect(barText()).not.toContain("Claude is waiting on it");
    expect(barText()).toMatch(expected);
  });
});

describe("#457 D5 — the exit/resume state is spoken (bar ON) through the one announcer", () => {
  it("open questions appearing after an exit: 'N questions waiting for Claude'", () => {
    useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: false }] } as any);
    useArtifactStore.setState({ artifacts: [art("a1", "research", "Done", { status: "approved" })] });
    render(<NextUpBar />);
    expect(announcer()).toBe("");
    act(() => useArtifactStore.setState({ comments: { a1: [question("q1", "a1"), question("q2", "a1")] } }));
    expect(announcer()).toBe("2 questions waiting for Claude");
  });

  it("Copy resume prompt speaks its result", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: false }] } as any);
    useArtifactStore.setState({ artifacts: [art("a1", "research", "Done", { status: "approved" })], comments: { a1: [question("q1", "a1")] } });
    render(<NextUpBar />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Copy resume prompt/ })); });
    expect(writeText).toHaveBeenCalled();
    expect(announcer()).toMatch(/^Copied ✓/);
  });
});

describe("#457 D2 — which session is blocked?", () => {
  it("with two sessions merged, the line and the ⌄ queue name the item's session", () => {
    useConnectionStore.setState({ activeSessions: [
      { sessionId: "s1", live: true, title: "Session cache design" },
      { sessionId: "s2", live: true, title: "Billing export" },
    ] } as any);
    useArtifactStore.setState({ artifacts: [
      art("d2", "decision", "Which store backs billing?", { sessionId: "s2", content: { context: "c", decisionId: "x", options: [] } }),
      art("r1", "research", "Done here", { status: "approved" }),
    ] });
    render(<NextUpBar />);
    expect(screen.getByTestId("next-up-session")).toHaveTextContent("in Billing export");
    fireEvent.click(screen.getByRole("button", { name: "Expand next-up details" }));
    const decide = within(screen.getByTestId("next-up-bar")).getByText("Decide (1)").parentElement!;
    expect(decide.textContent).toMatch(/Which store backs billing\?\s*— Billing export/);
  });

  it("one session: no label (nothing to disambiguate)", () => {
    useArtifactStore.setState({ artifacts: [art("d1", "decision", "Pick", { content: { context: "c", decisionId: "x", options: [] } })] });
    render(<NextUpBar />);
    expect(screen.queryByTestId("next-up-session")).not.toBeInTheDocument();
  });
});

describe("#457 D8 — a store reset/refill on connect is not announced", () => {
  it("review → (reset) nothing → review within the settle window stays silent", () => {
    vi.useFakeTimers({ now: Date.now() });
    useArtifactStore.setState({ artifacts: [art("r1", "research", "Finding 1")] });
    render(<NextUpBar />);
    act(() => useArtifactStore.getState().reset());
    act(() => useArtifactStore.setState({ artifacts: [art("r1", "research", "Finding 1")] }));
    expect(announcer()).toBe("");
    // After settling, a REAL change is still announced.
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => useArtifactStore.setState({ artifacts: [art("r0", "research", "Older finding", { createdAt: "2026-01-01T00:00:00.000Z" }), art("r1", "research", "Finding 1")] }));
    expect(announcer()).toBe("Next up: review — Older finding");
  });
});

describe("#457 D7 — Shift+n goes to the previous pending item", () => {
  it("n forward, N back (wrapping)", () => {
    usePreferencesStore.setState({ nextUpBar: false } as any);
    useArtifactStore.setState({ artifacts: [art("r1", "research", "One"), art("r2", "research", "Two"), art("r3", "research", "Three")], selectedArtifactId: "r2" });
    render(<App />);
    fireEvent.keyDown(document.body, { key: "N", shiftKey: true });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("r1");
    fireEvent.keyDown(document.body, { key: "N", shiftKey: true });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("r3");
    fireEvent.keyDown(document.body, { key: "n" });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("r1");
  });
});

describe("#457 state G — the bar escalates a prolonged outage", () => {
  it("under a minute: no doctor chip; past a minute: 'doctor --fix'", () => {
    useConnectionStore.setState({ connected: false, disconnectedSince: Date.now() - 5_000 } as any);
    const { unmount } = render(<NextUpBar />);
    expect(screen.queryByTestId("next-up-doctor")).not.toBeInTheDocument();
    unmount();
    useConnectionStore.setState({ connected: false, disconnectedSince: Date.now() - 61_000 } as any);
    render(<NextUpBar />);
    expect(screen.getByTestId("next-up-doctor")).toHaveTextContent("doctor --fix");
  });
});
