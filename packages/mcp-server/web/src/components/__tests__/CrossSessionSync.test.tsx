import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import App from "../../App";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";
import { useToastStore } from "../../stores/toast";

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

describe("#458 review — sibling history is not news; a sibling's NEW work is", () => {
  const research = (id: string, sessionId: string, title: string, createdAt: string, status = "draft") => ({
    id, sessionId, type: "research", version: 1, parentId: null, title, status,
    content: { summary: "s", findings: [] }, agentReasoning: null, createdAt, updatedAt: createdAt,
  });
  const decision = (id: string, sessionId: string, title: string, createdAt: string) => ({
    id, sessionId, type: "decision", version: 1, parentId: null, title, status: "draft",
    content: { context: "c", decisionId: `dd_${id}`, options: [] }, agentReasoning: null, createdAt, updatedAt: createdAt,
  });
  const glows = () => document.querySelectorAll(".dp-arrival-glow, .dp-arrival-ring").length;
  const arrivalText = () => screen.queryByTestId("arrival-live-region")?.textContent ?? "";
  const barAnnouncer = () => screen.getByTestId("next-up-announcer").textContent ?? "";

  const serve = (sibling: () => unknown[]) => vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
    if (String(url).includes("/api/live-session/s_bill")) return json({ artifacts: sibling(), comments: [] });
    if (String(url).includes("/api/live-session/")) return json({ artifacts: [], comments: [] });
    if (String(url).includes("/api/active-sessions")) return json({ sessions: useConnectionStore.getState().activeSessions });
    return json({ sessions: [] });
  }));

  it("a hydration reset re-merges sibling history at once: zero arrival announcements, zero glows, bar silent", async () => {
    const bound = research("b1", "s_q", "Bound finding", "2026-06-02T00:00:00.000Z", "approved");
    const older = research("o1", "s_bill", "An older billing finding", "2026-06-01T00:00:00.000Z");
    serve(() => [older]);
    useConnectionStore.setState({ sessionId: "s_q", activeSessions: [
      { sessionId: "s_q", live: true, artifactCount: 1 }, { sessionId: "s_bill", live: true, artifactCount: 1 },
    ] } as any);
    useArtifactStore.setState({ artifacts: [bound as any] });
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<App />);
    await waitFor(() => expect(useArtifactStore.getState().artifacts.some((a) => a.id === "o1")).toBe(true));
    // The connect payload: reset, then the bound session's snapshot.
    act(() => {
      useArtifactStore.getState().reset();
      useArtifactStore.setState({ artifacts: [bound as any] });
    });
    await waitFor(() => expect(useArtifactStore.getState().artifacts.some((a) => a.id === "o1")).toBe(true), { timeout: 7000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 1200)); }); // past every settle window
    expect(arrivalText()).toBe("");
    expect(glows()).toBe(0);
    expect(barAnnouncer()).not.toContain("older billing");
  }, 15_000);

  it("a sibling's NEW decision after its backfill reaches the bar as soon as the session poll sees it, announced once", async () => {
    let sibling: unknown[] = [research("o1", "s_bill", "Done billing work", "2026-06-01T00:00:00.000Z", "approved")];
    serve(() => sibling);
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<App />);
    await waitFor(() => expect(useArtifactStore.getState().artifacts.some((a) => a.id === "o1")).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 1000)); }); // settled
    expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).toMatch(/Nothing needs you/);

    // The sibling's agent presents a decision. Its broadcast is session-scoped
    // (never reaches this tab); the 10s /api/active-sessions poll sees count 2.
    sibling = [...sibling, decision("n1", "s_bill", "Ship the invoice batch now?", new Date().toISOString())];
    act(() => useConnectionStore.setState({ activeSessions: [
      { sessionId: "s_new", live: true, artifactCount: 0 }, { sessionId: "s_bill", live: true, artifactCount: 2 },
    ] } as any));
    await waitFor(() => expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).toMatch(/^▲ Ship the invoice batch now\?.*Decide 1/), { timeout: 2000 });
    expect(barAnnouncer()).toBe("Next up: decide — Ship the invoice batch now?");
    // …once: the arrival region leaves `next` to the bar.
    expect(arrivalText()).not.toContain("Ship the invoice batch");
  }, 15_000);
});

describe("#460 — the sibling change signal covers status changes and questions", () => {
  const mkDecision = (status = "draft") => ({
    id: "d_bill", sessionId: "s_bill", type: "decision", version: 1, parentId: null,
    title: "Which store backs the billing cache?", status,
    content: { context: "c", decisionId: "dd_bill", stakes: "high", options: [] },
    agentReasoning: null, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
  });
  const finding = (status = "approved") => ({
    id: "f_bill", sessionId: "s_bill", type: "research", version: 1, parentId: null, title: "Billing finding", status,
    content: { summary: "s", findings: [] }, agentReasoning: null, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
  });
  const sessions = (rev: number | undefined, count = 1) => [
    { sessionId: "s_new", live: true, artifactCount: 0, ...(rev === undefined ? {} : { revision: 0 }) },
    { sessionId: "s_bill", live: true, artifactCount: count, ...(rev === undefined ? {} : { revision: rev }) },
  ];
  let sibling: { artifacts: unknown[]; comments: unknown[] };
  let liveSessionCalls = 0;
  let statusResponse: () => Promise<Response> = () => json({ ok: true });
  beforeEach(() => {
    liveSessionCalls = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/api/live-session/s_bill")) { liveSessionCalls++; return json(sibling); }
      if (u.includes("/api/live-session/")) return json({ artifacts: [], comments: [] });
      if (u.includes("/api/artifacts/") && u.endsWith("/status")) return statusResponse();
      if (u.includes("/api/active-sessions")) return json({ sessions: useConnectionStore.getState().activeSessions });
      return json({ sessions: [] });
    }));
  });
  const line = () => screen.getByTestId("next-up-bar").getAttribute("data-line") ?? "";

  it("a sibling decision approved elsewhere (count unchanged) leaves the bar on the next poll", async () => {
    sibling = { artifacts: [mkDecision()], comments: [] };
    useConnectionStore.setState({ activeSessions: sessions(1) } as any);
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<App />);
    await waitFor(() => expect(line()).toMatch(/^▲ Which store backs the billing cache\?/));
    sibling = { artifacts: [mkDecision("approved")], comments: [] };
    act(() => useConnectionStore.setState({ activeSessions: sessions(2) } as any)); // the poll: revision moved, count didn't
    await waitFor(() => expect(line()).toMatch(/Nothing needs you/), { timeout: 2000 });
  });

  it("a sibling's new QUESTION (a comment — count unchanged) appears in Waiting", async () => {
    sibling = { artifacts: [finding()], comments: [] };
    useConnectionStore.setState({ activeSessions: sessions(1) } as any);
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<App />);
    await waitFor(() => expect(useArtifactStore.getState().artifacts.some((a) => a.id === "f_bill")).toBe(true));
    sibling = { artifacts: [finding()], comments: [{
      id: "q_bill", sessionId: "s_bill", target: { artifactId: "f_bill" }, parentCommentId: null, author: "human",
      content: "Why is the hit rate 12%?", acknowledged: false, createdAt: "2026-06-01T01:00:00.000Z", intent: "question",
    }] };
    act(() => useConnectionStore.setState({ activeSessions: sessions(2) } as any));
    await waitFor(() => expect(line()).toMatch(/^◌ WAITING ON CLAUDE/), { timeout: 2000 });
  });

  it("acting on a stale card: the daemon's verdict_already_final shows the TRUE status, a clear message, and re-fetches the sibling", async () => {
    sibling = { artifacts: [finding("draft")], comments: [] };
    useConnectionStore.setState({ activeSessions: sessions(1) } as any);
    render(<App />);
    await waitFor(() => expect(useArtifactStore.getState().artifacts.find((a) => a.id === "f_bill")?.status).toBe("draft"));
    statusResponse = () => Promise.resolve(new Response(JSON.stringify({
      error: "verdict_already_final", code: "verdict_already_final", currentStatus: "approved",
      message: "This artifact was already approved in another tab. A finalized verdict can't be reversed — this tab has been refreshed to the current state.",
    }), { status: 409, headers: { "Content-Type": "application/json" } }));
    sibling = { artifacts: [finding("approved")], comments: [] };
    const callsBefore = liveSessionCalls;
    await act(async () => {
      await useArtifactStore.getState().updateArtifactStatus("f_bill", "rejected").catch(() => {});
    });
    // The truth, not the rolled-back stale draft.
    expect(useArtifactStore.getState().artifacts.find((a) => a.id === "f_bill")?.status).toBe("approved");
    expect(useToastStore.getState().toasts.some((t) => /already approved in another tab/.test(t.body ?? ""))).toBe(true);
    await waitFor(() => expect(liveSessionCalls).toBeGreaterThan(callsBefore));
  });

  it("an OLD daemon (no revision field) still refreshes a sibling on its artifact count", async () => {
    sibling = { artifacts: [finding()], comments: [] };
    useConnectionStore.setState({ activeSessions: sessions(undefined, 1) } as any);
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<App />);
    await waitFor(() => expect(useArtifactStore.getState().artifacts.some((a) => a.id === "f_bill")).toBe(true));
    sibling = { artifacts: [finding(), { ...mkDecision(), createdAt: new Date().toISOString() }], comments: [] };
    act(() => useConnectionStore.setState({ activeSessions: sessions(undefined, 2) } as any));
    await waitFor(() => expect(line()).toMatch(/^▲ Which store backs the billing cache\?/), { timeout: 2000 });
  });

  it("an unchanged revision costs nothing (no re-fetch of a quiet sibling)", async () => {
    sibling = { artifacts: [finding()], comments: [] };
    useConnectionStore.setState({ activeSessions: sessions(3) } as any);
    render(<App />);
    await waitFor(() => expect(liveSessionCalls).toBe(1));
    act(() => useConnectionStore.setState({ activeSessions: sessions(3).map((s) => ({ ...s })) } as any)); // same values, new identity
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(liveSessionCalls).toBe(1);
  });
});
