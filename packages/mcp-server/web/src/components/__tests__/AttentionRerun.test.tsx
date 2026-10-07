import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import App from "../../App";
import { NextUpBar } from "../NextUpBar";
import { DecisionCard } from "../DecisionCard";
import { MessageInput } from "../MessageInput";
import { ArtifactStatusActions } from "../artifacts/ArtifactStatusActions";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";
import { outageMinutes } from "../../lib/outage";
import { OFFLINE_ACT_REASON } from "../../hooks/useOfflineReason";

/**
 * #465 — the walkthrough RERUN's findings (docs/design/attention-walkthroughs.md,
 * "New defects" N1–N4) plus state G rule 1 (act buttons while disconnected).
 */
const art = (id: string, sessionId: string, type: string, title: string, over: Record<string, unknown> = {}) => ({
  id, sessionId, type, version: 1, parentId: null, title, status: "draft",
  content: {}, agentReasoning: null, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", ...over,
}) as any;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))));
  useArtifactStore.getState().reset();
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any);
  useReplayStore.setState({ active: false } as any);
  useConnectionStore.setState({
    connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }],
    staleDaemon: false, snapshotUnavailable: false, sessionConflict: false, agentActivityAt: null, disconnectedSince: null,
  } as any);
  usePreferencesStore.setState({ nextUpBar: false } as any);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const goOffline = (since = Date.now()) => useConnectionStore.setState({ connected: false, disconnectedSince: since } as any);

describe("N1 — label an item from any session other than the bound one", () => {
  it("bound s_new is empty and ONE sibling holds the decision: the line names the sibling", () => {
    useConnectionStore.setState({ sessionId: "s_new", activeSessions: [
      { sessionId: "s_new", live: true, title: "s_new" },
      { sessionId: "s_bill", live: true, title: "Billing migration" },
    ] } as any);
    useArtifactStore.setState({ artifacts: [art("d1", "s_bill", "decision", "Backfill invoices now?", { content: { context: "c", decisionId: "x", options: [] } })] });
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<NextUpBar />);
    expect(screen.getByTestId("next-up-session")).toHaveTextContent("in Billing migration");
  });

  it("an item from the BOUND session (single session) stays unlabelled", () => {
    useArtifactStore.setState({ artifacts: [art("d1", "s1", "decision", "Pick", { content: { context: "c", decisionId: "x", options: [] } })] });
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<NextUpBar />);
    expect(screen.queryByTestId("next-up-session")).not.toBeInTheDocument();
  });
});

describe("N2/N3 — the disconnect banner: no false outage on load, and it's the TAB that's offline", () => {
  it("before the first connect: nothing is announced during the grace period", () => {
    vi.useFakeTimers({ now: Date.now() });
    useConnectionStore.setState({ connected: false, disconnectedSince: null } as any);
    render(<App />);
    expect(screen.queryByText(/lost its connection|Disconnected from server/)).not.toBeInTheDocument();
    // Never connected after the grace: a real outage at load still shows.
    act(() => { vi.advanceTimersByTime(3100); });
    expect(screen.getByText(/This tab lost its connection to the deepPairing daemon/)).toBeInTheDocument();
  });

  it("after a connect, a real disconnect shows at once — in words about this tab, not Claude", () => {
    render(<App />);
    act(() => goOffline());
    const banner = screen.getByText(/This tab lost its connection to the deepPairing daemon — reconnecting/);
    expect(banner.closest("[role='status']")).not.toBeNull();
    expect(banner.textContent).not.toMatch(/Claude/);
  });
});

describe("N4 — the outage minutes floor, like every other duration label", () => {
  it("92s is 1 min; 2 min only from 120s", () => {
    expect(outageMinutes(92_000)).toBe(1);
    expect(outageMinutes(119_999)).toBe(1);
    expect(outageMinutes(120_000)).toBe(2);
  });

  it("the bar-OFF banner reads '1 min' at ~92s", () => {
    render(<App />);
    act(() => goOffline(Date.now() - 92_000));
    expect(screen.getByText(/offline for 1 min/)).toBeInTheDocument();
    expect(screen.queryByText(/2 min/)).not.toBeInTheDocument();
  });
});

describe("state G rule 1 — act buttons disable while disconnected, with the reason; drafts are kept", () => {
  const research = art("art_x", "s1", "research", "Test artifact");

  it("review footer: Approve disables with the reason and re-enables on reconnect; the typed comment stays", () => {
    render(<ArtifactStatusActions artifact={research} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "my draft note" } });
    act(() => goOffline());
    const approve = screen.getAllByRole("button", { name: /^Approve/ })[0]!;
    expect(approve).toBeDisabled();
    expect(approve.getAttribute("title")).toBe(OFFLINE_ACT_REASON);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("my draft note");
    act(() => useConnectionStore.setState({ connected: true, disconnectedSince: null } as any));
    expect(screen.getAllByRole("button", { name: /^Approve/ })[0]).toBeEnabled();
  });

  it("decision: Select disables with the reason (and the keyboard path is refused too)", () => {
    const event = {
      type: "decision_request" as const, decisionId: "dec_off", context: "Which cache?",
      options: [{ id: "o1", title: "Redis", description: "d", pros: [], cons: [], effort: "low" as const, risk: "low" as const, recommendation: true }],
    };
    const resolveDecision = vi.fn().mockResolvedValue(undefined);
    useArtifactStore.setState({ resolveDecision } as any);
    act(() => goOffline());
    render(<DecisionCard event={event} decisionId="dec_off" artifactId="art1" />);
    const select = screen.getByRole("button", { name: "Select Redis" });
    expect(select).toBeDisabled();
    expect(select.getAttribute("title")).toBe(OFFLINE_ACT_REASON);
    fireEvent.click(select);
    expect(resolveDecision).not.toHaveBeenCalled();
  });

  it("composer: Send disables with the reason; the message is kept", () => {
    render(<MessageInput />);
    const box = screen.getByPlaceholderText(/Message the agent/);
    fireEvent.change(box, { target: { value: "please also check the 401 path" } });
    act(() => goOffline());
    const send = screen.getByRole("button", { name: /^Send/ });
    expect(send).toBeDisabled();
    expect(send.getAttribute("title")).toBe(OFFLINE_ACT_REASON);
    expect((screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement).value).toBe("please also check the 401 path");
  });
});
