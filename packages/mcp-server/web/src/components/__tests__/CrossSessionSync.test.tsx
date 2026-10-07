import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "../../App";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";

/**
 * #457 D6 (docs/design/attention-walkthroughs.md) — "Nothing needs you" when the
 * bound session is empty. MultiAgentSync lived inside ArtifactPanel, which only
 * mounts once the BOUND session has artifacts, so an empty bound session never
 * merged its siblings: the bar claimed "◇ Nothing needs you" (and, bar OFF, the
 * pending banner stayed silent) while another live session held a decision.
 */
const SESSIONS = [
  { sessionId: "s_new", live: true, artifactCount: 0 },
  { sessionId: "s_bill", live: true, artifactCount: 1 },
];
const billDecision = {
  id: "d_bill", sessionId: "s_bill", type: "decision", version: 1, parentId: null,
  title: "Which store backs the billing cache?", status: "draft",
  content: { context: "Needed before the invoice run.", decisionId: "dd_bill", stakes: "high", options: [] },
  agentReasoning: null, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
};

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  useArtifactStore.getState().reset();
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any);
  useReplayStore.setState({ active: false } as any);
  useConnectionStore.setState({
    connected: true, hydrated: true, sessionId: "s_new", activeSessions: SESSIONS,
    staleDaemon: false, snapshotUnavailable: false, sessionConflict: false, agentActivityAt: null,
  } as any);
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
    if (String(url).includes("/api/live-session/s_bill")) return json({ artifacts: [billDecision], comments: [] });
    if (String(url).includes("/api/live-session/")) return json({ artifacts: [], comments: [] });
    if (String(url).includes("/api/active-sessions")) return json({ sessions: SESSIONS });
    return json({ sessions: [] });
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("#457 D6 — an empty bound session still merges its siblings", () => {
  it("bar ON: the sibling's decision is Decide 1 — not '◇ Nothing needs you'", async () => {
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).toMatch(/^▲ Which store backs the billing cache\?/));
    expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).toContain("Decide 1");
    expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).not.toContain("Nothing needs you");
  });

  it("bar OFF: the tab title counts it and the decision is on screen (was: an empty-session shell)", async () => {
    usePreferencesStore.setState({ nextUpBar: false } as any);
    render(<App />);
    await waitFor(() => expect(document.title).toMatch(/^\(1\)/));
    // The panel mounts with the sibling's decision (the single pending card in
    // view — so PendingBanner's J2b step-down rightly stays quiet).
    await waitFor(() => expect(screen.getAllByText("Which store backs the billing cache?").length).toBeGreaterThan(0));
  });

  it("a store reset (session switch / hydration) re-merges the siblings it discarded", async () => {
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<App />);
    await waitFor(() => expect(useArtifactStore.getState().artifacts.some((a) => a.id === "d_bill")).toBe(true));
    useArtifactStore.getState().reset();
    expect(useArtifactStore.getState().artifacts).toHaveLength(0);
    // The 5s tick (fake-free: wait it out) backfills again — no 30s backoff,
    // no "already loaded" skip from the discarded store.
    await waitFor(() => expect(useArtifactStore.getState().artifacts.some((a) => a.id === "d_bill")).toBe(true), { timeout: 7000 });
  }, 10_000);
});
