import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import App from "../../App";
import { ResearchArtifact } from "../artifacts/ResearchArtifact";
import { SuggestionCard } from "../SuggestionCard";
import { ConversationRail } from "../ConversationRail";
import { RequestComposerBanner, OPEN_REQUEST_COMPOSER_EVENT } from "../RequestComposerBanner";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";
import { useConnectionGraceStore, HYDRATION_STALL_MS } from "../../lib/connectionGrace";
import { OFFLINE_ACT_REASON } from "../../hooks/useOfflineReason";

/**
 * #477 — the act paths #467 left ungated, through the SAME shared offline
 * condition (lib/connectionGrace) and the same visible reason; and the D8 edge
 * where a connected tab's first snapshot never applies.
 */
const now = "2026-06-01T00:00:00.000Z";

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
  useConnectionGraceStore.setState({ everConnected: true, graceOver: false, hydrationStalled: false });
  usePreferencesStore.setState({ nextUpBar: false } as any);
});
afterEach(() => {
  useConnectionGraceStore.setState({ everConnected: false, graceOver: false, hydrationStalled: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const goOffline = () => useConnectionStore.setState({ connected: false, disconnectedSince: Date.now() } as any);
const reconnect = () => useConnectionStore.setState({ connected: true, disconnectedSince: null } as any);
const expectGated = (el: HTMLElement) => {
  expect(el).toBeDisabled();
  expect(el.getAttribute("title")).toBe(OFFLINE_ACT_REASON);
};

describe("#477 — the remaining act paths gate offline, with the reason, and re-enable", () => {
  it("ResearchArtifact: a finding's Approve verdict", () => {
    const art = {
      id: "r1", sessionId: "s1", type: "research", version: 1, parentId: null, title: "Audit", status: "draft",
      content: { summary: "s", findings: [{ category: "Data", title: "Low hit rate", detail: "d", significance: "high" }] },
      agentReasoning: null, createdAt: now, updatedAt: now,
    } as any;
    useArtifactStore.setState({ artifacts: [art] } as any);
    render(<ResearchArtifact artifact={art} />);
    act(() => goOffline());
    expectGated(screen.getByRole("button", { name: "Approve finding 1" }));
    act(() => reconnect());
    expect(screen.getByRole("button", { name: "Approve finding 1" })).toBeEnabled();
  });

  it("SuggestionCard: Take the counter / Insist on mine", () => {
    const comment = {
      id: "cmt_s", sessionId: "s1", target: { artifactId: "art_1", lineStart: 3, lineEnd: 3, filePath: "a.ts" },
      parentCommentId: null, author: "human", content: "x", intent: "suggestion", acknowledged: false, createdAt: now,
      suggestion: { originalText: "a", replacementText: "b", lineStart: 3, lineEnd: 3, state: "countered" },
    } as any;
    render(<SuggestionCard comment={comment} replies={[]} />);
    act(() => goOffline());
    expectGated(screen.getByRole("button", { name: "Take the counter" }));
    expectGated(screen.getByRole("button", { name: "Insist on mine" }));
    act(() => reconnect());
    expect(screen.getByRole("button", { name: "Take the counter" })).toBeEnabled();
  });

  it("ConversationRail: a thread reply's send (the typed reply is kept)", () => {
    useArtifactStore.setState({
      artifacts: [{ id: "a1", sessionId: "s1", type: "research", version: 1, parentId: null, title: "A1", status: "draft", content: { summary: "x", findings: [] }, agentReasoning: null, createdAt: now, updatedAt: now }],
      comments: { a1: [{ id: "c1", sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null, author: "agent", content: "Here is why", acknowledged: false, createdAt: now }] },
    } as any);
    render(<ConversationRail onClose={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Reply in this thread" })[0]!);
    const box = screen.getByPlaceholderText(/Continue the thread/);
    fireEvent.change(box, { target: { value: "draft follow-up" } });
    act(() => goOffline());
    expectGated(screen.getByRole("button", { name: "Reply" }));
    expect((screen.getByPlaceholderText(/Continue the thread/) as HTMLTextAreaElement).value).toBe("draft follow-up");
    act(() => reconnect());
    expect(screen.getByRole("button", { name: "Reply" })).toBeEnabled();
  });

  it("RequestComposer: Send request (the typed request is kept)", () => {
    render(<RequestComposerBanner />);
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_REQUEST_COMPOSER_EVENT)); });
    const input = screen.getByRole("textbox", { name: "Your request to Claude" });
    fireEvent.change(input, { target: { value: "Explain the cache" } });
    act(() => goOffline());
    // The composer row renders only while connected? It must stay mounted offline.
    const send = screen.getByRole("button", { name: "Send request" });
    expectGated(send);
    expect((screen.getByRole("textbox", { name: "Your request to Claude" }) as HTMLInputElement).value).toBe("Explain the cache");
    act(() => reconnect());
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
  });
});

describe("#477 — a connected tab whose first snapshot never applies", () => {
  it(`bar ON: past ${HYDRATION_STALL_MS / 1000}s the hold becomes "Couldn't load the current state" with Reload; a late hydration clears it`, () => {
    vi.useFakeTimers({ now: Date.now() });
    usePreferencesStore.setState({ nextUpBar: true } as any);
    useConnectionStore.setState({ connected: true, hydrated: false } as any);
    render(<App />);
    const line = () => screen.getByTestId("next-up-bar").getAttribute("data-line");
    expect(line()).toBe("Checking what needs you…");
    act(() => { vi.advanceTimersByTime(HYDRATION_STALL_MS - 500); });
    expect(line()).toBe("Checking what needs you…"); // not before the bound
    act(() => { vi.advanceTimersByTime(1000); });
    expect(line()).toBe("⚠ Couldn't load the current state");
    expect(screen.getByTestId("next-up-reload")).toHaveTextContent("Reload");
    act(() => useConnectionStore.setState({ hydrated: true } as any));
    expect(line()).not.toMatch(/Couldn't load/);
    expect(screen.queryByTestId("next-up-reload")).not.toBeInTheDocument();
  });

  it("bar OFF: the same truthful banner with Reload, cleared by a late hydration", () => {
    vi.useFakeTimers({ now: Date.now() });
    useConnectionStore.setState({ connected: true, hydrated: false } as any);
    render(<App />);
    act(() => { vi.advanceTimersByTime(HYDRATION_STALL_MS + 500); });
    const banner = screen.getByTestId("hydration-stalled");
    expect(banner).toHaveTextContent("Couldn't load the current state");
    expect(banner.closest("[role='status']")).not.toBeNull();
    act(() => useConnectionStore.setState({ hydrated: true } as any));
    expect(screen.queryByTestId("hydration-stalled")).not.toBeInTheDocument();
  });
});
