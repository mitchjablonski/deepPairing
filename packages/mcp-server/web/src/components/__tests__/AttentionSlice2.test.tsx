import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../../App";
import { ArtifactPanel, MultiAgentSync } from "../ArtifactPanel";
import { DiagnosticsMenu } from "../DiagnosticsMenu";
import { PendingBanner } from "../PendingBanner";
import { NARROW_VIEWPORT_QUERY } from "../../hooks/useMediaQuery";
import { useDocumentTitleBadge } from "../../hooks/useDocumentTitleBadge";
import { openGateLogEntry, gateEntryDomId } from "../../lib/stanceException";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { unreadBlockCount, usePreflightBlockStore, type PreflightBlockRecord } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";
import { useSiblingSyncStore } from "../../lib/siblingSync";

/**
 * #430 slice 2, Sol's conditions 1-4. D1: the bar-OFF Agents row becomes the
 * sidebar menu while the sidebar is expanded, and stays a filter. D2: a held
 * terminal ask gets a real Why, meaning viewed and never answered, plus the
 * focus return it needs. Real stores and a fake daemon, no module mocks.
 */
const art = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: "s1", type: "research", version: 1, parentId: null, title, status: "approved",
  content: { summary: "s", findings: [] }, agentReasoning: null,
  createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", ...over,
}) as any;

const ask = (id: string, at: string, over: Partial<PreflightBlockRecord> = {}): PreflightBlockRecord => ({
  id, at, source: "session", concept: `stance ${id}`, via: "concept", lane: "hook", decision: "ask",
  toolName: "Edit", targetPath: "db/m.sql", ...over,
});
const stance = (id: string, at: string): PreflightBlockRecord => ({ id, serverId: id, at, source: "session", concept: `row ${id}`, via: "concept" });
const minute = (n: number) => `2026-06-01T01:${String(n).padStart(2, "0")}:00.000Z`;

/** A fake daemon: answers every route, records every request. */
function fakeDaemon(hydrate: () => Promise<PreflightBlockRecord[]> | PreflightBlockRecord[] = () => []) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const body = url.includes("/api/preflight-blocks") ? { blocks: await hydrate() } : { sessions: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { mutations: () => calls.filter((c) => c.method !== "GET" && c.method !== "HEAD") };
}

/** A controllable viewport: only the narrow query answers and fires. */
function fakeViewport(initialNarrow: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let narrow = initialNarrow;
  window.matchMedia = ((query: string) => ({
    get matches() { return query === NARROW_VIEWPORT_QUERY && narrow; },
    media: query,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => { if (query === NARROW_VIEWPORT_QUERY) listeners.add(l); },
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => { listeners.delete(l); },
  })) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    narrow = next;
    act(() => { for (const l of listeners) l({ matches: next } as MediaQueryListEvent); });
  };
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  useArtifactStore.getState().reset();
  useArtifactStore.setState({ agentFilter: "all", filterBinding: null });
  try { localStorage.removeItem("dp.gateBlocks.lastSeenAt"); } catch { /* unavailable */ }
  usePreflightBlockStore.setState({ blocks: [], liveRev: {}, lastSeenAt: null, loaded: true, focusRequest: null, logOpen: false });
  useReplayStore.setState({ active: false, exiting: false, cursor: "" });
  useSiblingSyncStore.setState({ settled: true });
  useConnectionStore.setState({
    connected: true, hydrated: true, hydratedBinding: null, projectRoot: null, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true, artifactCount: 1 }],
  } as any);
  usePreferencesStore.setState({ nextUpBar: false, sidebarCollapsed: false } as any);
});

afterEach(() => {
  useReplayStore.setState({ active: false, exiting: false, cursor: "" });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.matchMedia = realMatchMedia;
});

const setArtifacts = (artifacts: unknown[]) => act(() => { useArtifactStore.setState({ artifacts } as any); });
const menu = () => screen.getByTestId("agents-filter-menu") as HTMLSelectElement;
const inSidebar = (id: string) => document.querySelector(`nav[aria-label='Artifacts'] [data-artifact-item="${id}"]`);
const activeRowButton = () => document.querySelector<HTMLElement>("[data-agents-active]");

describe("#430 ordering follow-up — App banner/header consistency", () => {
  it.each([
    { name: "terminal-held lead", type: "research", over: {}, boundary: null, visible: true },
    { name: "older blocking draft displaces hold", type: "plan", over: {}, boundary: null, visible: false },
    { name: "daemon-seen hold", type: "research", over: { seenAt: minute(2) }, boundary: null, visible: false },
    { name: "hold at the unread boundary", type: "research", over: {}, boundary: minute(1), visible: false },
    { name: "ordinary denial is not a terminal ask", type: "research", over: { decision: "deny" as const }, boundary: null, visible: false },
  ])("selected sole draft: $name", async ({ type, over, boundary, visible }) => {
    const hold = ask("held", minute(1), over);
    fakeDaemon(() => [hold]);
    usePreflightBlockStore.setState({ blocks: [hold], lastSeenAt: boundary });
    useArtifactStore.setState({
      artifacts: [art("only", "Only draft", { type, status: "draft", content: type === "plan" ? { steps: [] } : { summary: "s", findings: [] } })],
      selectedArtifactId: "only",
    });
    render(<App />);
    await waitFor(() => {
      const banner = screen.queryByRole("region", { name: "Waiting for you" });
      const pill = screen.getByRole("button", { name: /Your turn —/ });
      if (visible) {
        expect(banner).toBeInTheDocument();
        expect(within(banner!).getByText("1 item waiting for you")).toBeInTheDocument();
        expect(screen.getByTestId("pending-next")).toHaveTextContent("HELD IN TERMINAL");
        expect(pill).toHaveTextContent(/^Your turn$/);
      } else {
        expect(banner).not.toBeInTheDocument();
        expect(pill).toHaveTextContent(/^1 for you$/);
      }
    });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("only");
  });

  it("updates the App's pill when the held lead leaves the unread set", async () => {
    const hold = ask("held", minute(1));
    fakeDaemon(() => [hold]);
    usePreflightBlockStore.setState({ blocks: [hold], lastSeenAt: null });
    useArtifactStore.setState({ artifacts: [art("only", "Only draft", { status: "draft" })], selectedArtifactId: "only" });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Your turn —/ })).toHaveTextContent(/^Your turn$/));
    act(() => { usePreflightBlockStore.setState({ lastSeenAt: minute(1) }); });
    expect(screen.queryByRole("region", { name: "Waiting for you" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Your turn —/ })).toHaveTextContent(/^1 for you$/);
  });
});

describe("#430 slice 2 D1 — the Agents filter with the bar OFF", () => {
  const two = () => [art("a1", "From agent one"), art("a2", "From agent two", { sessionId: "s2" })];

  it("is a labelled native select in the sidebar with total counts, and it filters", () => {
    fakeDaemon();
    setArtifacts([...two(), art("a3", "Superseded", { status: "superseded" })]);
    render(<ArtifactPanel />);
    expect(screen.queryByText("Agents:")).not.toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: /^Agents/ }) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.closest("nav[aria-label='Artifacts']")).not.toBeNull();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["All (2)", "Session 1 (1)", "Session 2 (1)"]);
    fireEvent.change(select, { target: { value: "s2" } });
    expect(inSidebar("a1")).toBeNull();
    expect(inSidebar("a2")).not.toBeNull();
    fireEvent.change(select, { target: { value: "all" } });
    expect(inSidebar("a1")).not.toBeNull();
  });

  it("names a demo session in its option text", () => {
    fakeDaemon();
    setArtifacts([art("a1", "Real"), art("d1", "Sample", { sessionId: "demo_1" })]);
    render(<ArtifactPanel />);
    expect(Array.from(menu().options).map((o) => o.textContent)).toEqual(["All (2)", "Session 1 (1)", "Session 2 · Demo (1)"]);
  });

  it("keeps the row when collapsed or narrow", () => {
    fakeDaemon();
    setArtifacts(two());
    usePreferencesStore.setState({ sidebarCollapsed: true } as any);
    const { unmount } = render(<ArtifactPanel />);
    expect(screen.getByText("Agents:")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-filter-menu")).not.toBeInTheDocument();
    unmount();
    usePreferencesStore.setState({ sidebarCollapsed: false } as any);
    fakeViewport(true);
    render(<ArtifactPanel />);
    expect(screen.getByText("Agents:")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-filter-menu")).not.toBeInTheDocument();
  });

  it("filtering changes neither the banner count nor the tab title", () => {
    fakeDaemon();
    const Title = () => { useDocumentTitleBadge(); return null; };
    setArtifacts([art("a1", "One", { status: "draft" }), art("a2", "Two", { status: "draft", sessionId: "s2" }), art("a3", "Three", { status: "draft", sessionId: "s2" })]);
    render(<><Title /><PendingBanner /><ArtifactPanel /></>);
    expect(screen.getByText("3 items waiting for you")).toBeInTheDocument();
    expect(document.title).toBe("(3) Your turn — deepPairing");
    fireEvent.change(menu(), { target: { value: "s1" } });
    expect(screen.getByText("3 items waiting for you")).toBeInTheDocument();
    expect(document.title).toBe("(3) Your turn — deepPairing");
  });

  it("keeps the selection across collapse and resize, and focus moves with the control", () => {
    fakeDaemon();
    const setNarrow = fakeViewport(false);
    setArtifacts(two());
    render(<ArtifactPanel />);
    fireEvent.change(menu(), { target: { value: "s2" } });
    menu().focus();

    act(() => usePreferencesStore.getState().toggleSidebar());
    expect(activeRowButton()).toHaveTextContent("Selected agent — s2 (1)");
    expect(activeRowButton()).toHaveFocus();
    expect(inSidebar("a1")).toBeNull();

    act(() => usePreferencesStore.getState().toggleSidebar());
    expect(menu().value).toBe("s2");
    expect(menu()).toHaveFocus();

    setNarrow(true);
    expect(activeRowButton()).toHaveTextContent("Selected agent — s2 (1)");
    expect(activeRowButton()).toHaveFocus();
    setNarrow(false);
    expect(menu().value).toBe("s2");
    expect(menu()).toHaveFocus();
  });

  it("collapsing doesn't pull focus from anywhere else", () => {
    fakeDaemon();
    setArtifacts(two());
    render(<><input aria-label="composer" /><ArtifactPanel /></>);
    const composer = screen.getByRole("textbox", { name: "composer" });
    composer.focus();
    act(() => usePreferencesStore.getState().toggleSidebar());
    expect(composer).toHaveFocus();
  });

  it("a sibling arriving keeps focus on the menu; the first sibling leaves focus where it was", () => {
    fakeDaemon();
    setArtifacts([art("a1", "One")]);
    render(<><input aria-label="composer" /><ArtifactPanel /></>);
    const composer = screen.getByRole("textbox", { name: "composer" });
    composer.focus();
    setArtifacts(two());
    expect(composer).toHaveFocus();
    const select = menu();
    select.focus();
    setArtifacts([...two(), art("a3", "From agent three", { sessionId: "s3" })]);
    expect(menu()).toBe(select);
    expect(select).toHaveFocus();
    expect(select.options).toHaveLength(4);
  });

  it("keeps the unavailable choice visible; keyboard Show all clears it permanently and returns focus", async () => {
    fakeDaemon();
    const three = [...two(), art("a3", "From agent three", { sessionId: "s3" })];
    setArtifacts(three);
    render(<ArtifactPanel />);
    fireEvent.change(menu(), { target: { value: "s3" } });
    menu().focus();

    setArtifacts(two());
    expect(menu()).toHaveFocus();
    expect(menu().value).toBe("s3");
    expect(menu().selectedOptions[0]).toHaveTextContent("Selected agent — s3 (0)");
    expect(inSidebar("a1")).toBeNull();
    expect(inSidebar("a2")).toBeNull();
    expect(screen.getByTestId("agent-filter-empty")).toHaveTextContent("No items from the selected agent are available in this view.");

    // Returning data resumes the retained choice, without displaying All.
    setArtifacts(three);
    expect(menu().value).toBe("s3");
    expect(inSidebar("a1")).toBeNull();
    expect(inSidebar("a3")).not.toBeNull();
    setArtifacts([art("a1", "From agent one")]);
    expect(menu().value).toBe("s3"); // still reachable with just one session
    const showAll = screen.getByRole("button", { name: "Show all agents" });
    showAll.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByTestId("agents-filter-menu")).not.toBeInTheDocument();
    expect(inSidebar("a1")).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-sidebar-toggle]"));
    setArtifacts(three);
    expect(menu().value).toBe("all");
    expect(inSidebar("a1")).not.toBeNull();
    expect(inSidebar("a3")).not.toBeNull();
    fireEvent.change(menu(), { target: { value: "s3" } });
    expect(menu().value).toBe("s3"); // explicit reselection still works
  });

  it.each(["unhydrated", "wrong binding", "siblings loading", "replay", "replay exit", "hidden reset"])(
    "preserves the chosen filter across transient absence during %s",
    (mode) => {
      fakeDaemon();
      const three = [...two(), art("a3", "From agent three", { sessionId: "s3" })];
      setArtifacts(three);
      render(<ArtifactPanel />);
      fireEvent.change(menu(), { target: { value: "s2" } });
      act(() => {
        if (mode === "unhydrated") useConnectionStore.setState({ hydrated: false });
        if (mode === "wrong binding") useConnectionStore.setState({ hydratedBinding: "old@project" });
        if (mode === "siblings loading") useSiblingSyncStore.setState({ settled: false });
        if (mode === "replay") useReplayStore.setState({ active: true });
        if (mode === "replay exit") useReplayStore.setState({ exiting: true });
        if (mode === "hidden reset") vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      });
      act(() => {
        if (mode === "hidden reset") useArtifactStore.getState().reset();
        useArtifactStore.setState({ artifacts: [three[0]!, three[2]!] });
      });
      expect(menu().value).toBe("s2");
      expect(menu().selectedOptions[0]).toHaveTextContent("Selected agent — s2 (0)");
      expect(inSidebar("a1")).toBeNull();
      expect(inSidebar("a3")).toBeNull();
      expect(screen.getByRole("button", { name: "Show all agents" })).toBeInTheDocument();
      setArtifacts(three);
      expect(menu().value).toBe("s2"); // the underlying choice survived
      expect(inSidebar("a1")).toBeNull();
      expect(inSidebar("a2")).not.toBeNull();
    },
  );

  it("does not clear an absent choice when hydration settles", () => {
    fakeDaemon();
    const three = [...two(), art("a3", "From agent three", { sessionId: "s3" })];
    setArtifacts(three);
    render(<ArtifactPanel />);
    fireEvent.change(menu(), { target: { value: "s2" } });
    act(() => useConnectionStore.setState({ hydrated: false }));
    setArtifacts([three[0]!, three[2]!]);
    act(() => useConnectionStore.setState({ hydrated: true }));
    expect(menu().value).toBe("s2");
    expect(inSidebar("a1")).toBeNull();
    setArtifacts(three);
    expect(menu().value).toBe("s2");
    expect(inSidebar("a1")).toBeNull();
    expect(inSidebar("a2")).not.toBeNull();
  });

  it("keeps the chosen view even when a successful catalog omits its session", () => {
    fakeDaemon();
    const three = [...two(), art("a3", "From agent three", { sessionId: "s3" })];
    useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: true }, { sessionId: "s2", live: true }] } as any);
    setArtifacts(three);
    render(<ArtifactPanel />);
    fireEvent.change(menu(), { target: { value: "s2" } });
    setArtifacts([three[0]!, three[2]!]);
    setArtifacts(three);
    expect(menu().value).toBe("s2");
    setArtifacts([three[0]!, three[2]!]);
    act(() => useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: true }] } as any));
    expect(menu().value).toBe("s2");
    expect(inSidebar("a1")).toBeNull();
    setArtifacts(three);
    expect(menu().value).toBe("s2");
    expect(inSidebar("a1")).toBeNull();
    expect(inSidebar("a2")).not.toBeNull();
  });

  it.each(["403", "500", "network", "missing sessions", "invalid session"])(
    "preserves the filter through failed backfill and a %s catalog response until explicit Show all",
    async (failure) => {
      const three = [...two(), art("a3", "From agent three", { sessionId: "s3" })];
      const sessions = ["s1", "s2", "s3"].map((sessionId) => ({ sessionId, title: sessionId, project: "p", artifactCount: 1, revision: 1, live: true }));
      useConnectionStore.setState({ activeSessions: sessions });
      let recovering = false;
      let departed = false;
      let backfillFailures = 0;
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/active-sessions")) {
          if (recovering) return json({ sessions: sessions.filter((s) => !departed || s.sessionId !== "s2").map((s) => ({ ...s, revision: departed ? 3 : 2 })) });
          if (failure === "network") throw new Error("offline");
          if (failure === "missing sessions") return json({ error: "invalid catalog" });
          if (failure === "invalid session") return json({ sessions: [{}] });
          return json({ error: "unavailable" }, Number(failure));
        }
        if (url.includes("/api/live-session/")) {
          if (!recovering) {
            backfillFailures++;
            if (failure === "network") throw new Error("offline");
            return json({ error: "unavailable" }, 500);
          }
          const sid = url.split("/api/live-session/")[1];
          return json({ artifacts: three.filter((a) => a.sessionId === sid), comments: [] });
        }
        return json({});
      });
      setArtifacts(three);
      render(<><ArtifactPanel /><MultiAgentSync /></>);
      fireEvent.change(menu(), { target: { value: "s2" } });
      await waitFor(() => expect(backfillFailures).toBeGreaterThan(0));
      act(() => {
        useArtifactStore.getState().reset();
        useArtifactStore.setState({ artifacts: [three[0]!, three[2]!] });
      });
      await waitFor(() => expect(useSiblingSyncStore.getState().settled).toBe(true));
      let refreshed = true;
      await act(async () => { refreshed = await useConnectionStore.getState().refreshSessions(); });
      expect(refreshed).toBe(false);
      expect(useConnectionStore.getState().activeSessions).toBe(sessions);
      // Recover through the real poll/backfill path, not a scripted restoration
      // of the selected artifact or the filter state.
      recovering = true;
      act(() => {
        useArtifactStore.getState().reset();
        useArtifactStore.setState({ artifacts: [three[0]!, three[2]!] });
      });
      await act(async () => { await useConnectionStore.getState().refreshSessions(); });
      await waitFor(() => expect(inSidebar("a2")).not.toBeNull());
      expect(menu().value).toBe("s2");
      expect(inSidebar("a1")).toBeNull();
      departed = true;
      setArtifacts([three[0]!, three[2]!]);
      await act(async () => { await useConnectionStore.getState().refreshSessions(); });
      expect(menu().value).toBe("s2");
      expect(inSidebar("a1")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Show all agents" }));
      await waitFor(() => expect(menu().value).toBe("all"));
      setArtifacts(three);
      expect(menu().value).toBe("all");
      expect(inSidebar("a1")).not.toBeNull();
    },
  );

  it.each([0, 1])("keeps recovery reachable with %s sessions through collapse/resize and keyboard Show all", async (count) => {
    fakeDaemon();
    const setNarrow = fakeViewport(false);
    setArtifacts(two());
    useArtifactStore.setState({ selectedArtifactId: "a2" });
    render(<ArtifactPanel />);
    fireEvent.change(menu(), { target: { value: "s2" } });
    menu().focus();
    setArtifacts(two().slice(0, count));
    expect(menu().value).toBe("s2");
    expect(menu().selectedOptions[0]).toHaveTextContent("Selected agent — s2 (0)");
    expect(menu()).toHaveFocus();
    expect(inSidebar("a1")).toBeNull();
    expect(screen.queryByText("Waiting for your agent's first move")).not.toBeInTheDocument();
    act(() => usePreferencesStore.getState().toggleSidebar());
    expect(activeRowButton()).toHaveTextContent("Selected agent — s2 (0)");
    expect(activeRowButton()).toHaveFocus();
    act(() => usePreferencesStore.getState().toggleSidebar());
    expect(menu()).toHaveFocus();
    setNarrow(true);
    expect(activeRowButton()).toHaveTextContent("Selected agent — s2 (0)");
    expect(activeRowButton()).toHaveFocus();
    setNarrow(false);
    expect(menu()).toHaveFocus();
    const before = useArtifactStore.getState().artifacts;
    screen.getByRole("button", { name: "Show all agents" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByTestId("agent-filter-empty")).not.toBeInTheDocument();
    if (count > 0) expect(document.querySelector("[data-sidebar-toggle]")).toHaveFocus();
    else expect(screen.getByText("Waiting for your agent's first move")).toBeInTheDocument();
    expect(useArtifactStore.getState().artifacts).toBe(before);
    expect(useArtifactStore.getState().selectedArtifactId).toBe(count ? "a1" : null);
    setArtifacts(two());
    expect(menu().value).toBe("all");
    expect(inSidebar("a1")).not.toBeNull();
    expect(inSidebar("a2")).not.toBeNull();
  });

  it("does not steal unrelated focus when an unavailable choice is cleared", () => {
    fakeDaemon();
    setArtifacts(two());
    render(<><input aria-label="composer" /><ArtifactPanel /></>);
    fireEvent.change(menu(), { target: { value: "s2" } });
    const composer = screen.getByRole("textbox", { name: "composer" });
    composer.focus();
    setArtifacts([two()[0]!]);
    expect(composer).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Show all agents" }));
    expect(composer).toHaveFocus();
    expect(inSidebar("a1")).not.toBeNull();
  });

  it("App preserves the chosen agent through zero items and hydration, then keyboard Show all restores the empty route and focus", async () => {
    fakeDaemon();
    // This is a filter/empty-route test, not a socket test. Retire any earlier
    // owned adapter and prevent App init from opening a real WebSocket while
    // userEvent yields; disconnects have their own explicit route case below.
    useConnectionStore.getState().disconnect();
    useConnectionStore.setState({ connected: true, hydrated: true, hydratedBinding: null, adapter: {
      connect() {}, disconnect() {}, onMessage() {}, onConnect() {}, onDisconnect() {},
    } });
    setArtifacts(two());
    useArtifactStore.setState({ selectedArtifactId: "a2" });
    const view = render(<App />);
    try {
    fireEvent.change(menu(), { target: { value: "s2" } });
    const panel = screen.getByTestId("artifact-panel");
    setArtifacts([]);
    expect(screen.getByRole("combobox", { name: /^Agents/ })).toBe(menu());
    expect(menu().selectedOptions[0]).toHaveTextContent("Selected agent — s2 (0)");
    expect(screen.queryByText("Waiting for your agent's first move")).not.toBeInTheDocument();
    act(() => useConnectionStore.setState({ hydrated: false }));
    expect(screen.getByTestId("artifact-panel")).toBe(panel); // hidden, not unmounted
    expect(screen.queryByRole("combobox", { name: /^Agents/ })).not.toBeInTheDocument();
    act(() => useConnectionStore.setState({ hydrated: true }));
    expect(screen.getByRole("combobox", { name: /^Agents/ })).toBe(menu());
    expect(menu().selectedOptions[0]).toHaveTextContent("Selected agent — s2 (0)");
    screen.getByRole("button", { name: "Show all agents" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByTestId("artifact-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Waiting for Claude" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveFocus();
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
    setArtifacts(two());
    expect(menu().value).toBe("all");
    expect(inSidebar("a1")).not.toBeNull();
    expect(inSidebar("a2")).not.toBeNull();
    } finally {
      view.unmount();
      useConnectionStore.getState().disconnect();
    }
  });

  it.each(["waiting", "drafting", "disconnected"])("App restores the normal %s empty route after filter → All → empty", async (route) => {
    fakeDaemon();
    setArtifacts(two());
    render(<App />);
    fireEvent.change(menu(), { target: { value: "s2" } });
    setArtifacts([two()[0]!]);
    fireEvent.click(screen.getByRole("button", { name: "Show all agents" }));
    act(() => {
      useConnectionStore.setState({
        connected: route !== "disconnected", hydrated: true,
        activeSessions: [{ sessionId: "s1", live: true, artifactCount: 0 }],
        agentActivityAt: route === "drafting" ? Date.now() : null,
      } as any);
      useArtifactStore.getState().reset();
    });
    expect(screen.queryByTestId("artifact-panel")).not.toBeInTheDocument();
    if (route === "disconnected") {
      expect(screen.getByRole("button", { name: "Past sessions" })).toBeInTheDocument();
    } else {
      expect(screen.getByRole("status", { name: route === "drafting" ? "Claude is connected" : "Waiting for Claude" })).toBeInTheDocument();
    }
  });

  it("App clears the chosen agent on a real session-tab switch, but not same-session catalog loss", async () => {
    const sessions = ["s1", "s2"].map((sessionId) => ({ sessionId, title: `Session ${sessionId}`, project: "p", live: true, artifactCount: 1 }));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/active-sessions")) return json({ sessions });
      if (url.includes("/api/live-session/")) return json({ artifacts: [], comments: [] });
      if (url.includes("/api/preflight-blocks")) return json({ blocks: [] });
      return json({});
    });
    const previousAdapter = useConnectionStore.getState().adapter;
    const switched: string[] = [];
    // The actual store switchSession publishes the identity and resets the
    // frame before this adapter receives the switch, as with a real socket.
    const adapter = { switchSession: (sid: string) => {
      switched.push(sid);
      useConnectionStore.setState({ hydrated: true, hydratedBinding: null });
    } };
    useConnectionStore.setState({ adapter: adapter as any, activeSessions: sessions });
    try {
      setArtifacts(two());
      render(<App />);
      fireEvent.change(menu(), { target: { value: "s2" } });
      act(() => {
        useArtifactStore.getState().reset();
        useConnectionStore.setState({ activeSessions: sessions.slice(0, 1), projectRoot: "p", daemonStartedAt: "new-daemon" });
      });
      expect(menu().value).toBe("s2");
      expect(screen.getByRole("button", { name: "Show all agents" })).toBeInTheDocument();
      setArtifacts(two());
      expect(menu().value).toBe("s2");
      expect(inSidebar("a1")).toBeNull();
      act(() => useConnectionStore.setState({ activeSessions: sessions }));
      fireEvent.click(within(screen.getByRole("navigation", { name: "Sessions" })).getByRole("button", { name: /^Session s2\b/ }));
      expect(useConnectionStore.getState().sessionId).toBe("s2");
      expect(screen.queryByTestId("agent-filter-empty")).not.toBeInTheDocument();
      await waitFor(() => expect(switched).toEqual(["s2"]));
      expect(screen.queryByTestId("artifact-panel")).not.toBeInTheDocument();
      expect(screen.getByRole("status", { name: "Waiting for Claude" })).toBeInTheDocument();
      setArtifacts(two());
      expect(menu().value).toBe("all");
      expect(inSidebar("a1")).not.toBeNull();
      expect(inSidebar("a2")).not.toBeNull();
    } finally {
      useConnectionStore.setState({ adapter: previousAdapter });
    }
  });

  it("retains the visible choice through a daemon restart's successful partial catalog and lazy re-registration", async () => {
    const sessions = ["s1", "s2"].map((sessionId) => ({ sessionId, title: sessionId, project: "p", artifactCount: 1, revision: 1, live: true }));
    useConnectionStore.setState({ activeSessions: sessions, daemonStartedAt: "daemon-before" });
    let reregistered = false;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/active-sessions")) return json({ sessions: reregistered ? sessions : sessions.slice(0, 1) });
      const sid = url.split("/api/live-session/")[1];
      return json({ artifacts: two().filter((a) => a.sessionId === sid && (reregistered || sid === "s1")), comments: [] });
    });
    setArtifacts(two());
    useSiblingSyncStore.setState({ settled: false });
    render(<><ArtifactPanel /><MultiAgentSync /></>);
    await waitFor(() => expect(useSiblingSyncStore.getState().settled).toBe(true));
    fireEvent.change(menu(), { target: { value: "s2" } });
    act(() => {
      useConnectionStore.setState({ daemonStartedAt: "daemon-after" });
      useArtifactStore.getState().reset();
      useArtifactStore.setState({ artifacts: [two()[0]!] });
    });
    // Complete this snapshot's pass before the next catalog membership change;
    // the scenario under test is successful omission, not an aborted backfill.
    await waitFor(() => expect(useSiblingSyncStore.getState().settled).toBe(true));
    await act(async () => { expect(await useConnectionStore.getState().refreshSessions()).toBe(true); });
    await waitFor(() => expect(useSiblingSyncStore.getState().settled).toBe(true));
    expect(menu().value).toBe("s2");
    expect(menu().selectedOptions[0]).toHaveTextContent("Selected agent — p (s2) (0)");
    expect(inSidebar("a1")).toBeNull();
    expect(screen.getByRole("button", { name: "Show all agents" })).toBeInTheDocument();
    reregistered = true;
    act(() => {
      useArtifactStore.getState().reset();
      useArtifactStore.setState({ artifacts: [two()[0]!] });
    });
    await waitFor(() => expect(useSiblingSyncStore.getState().settled).toBe(true));
    await act(async () => { await useConnectionStore.getState().refreshSessions(); });
    await waitFor(() => expect(inSidebar("a2")).not.toBeNull());
    expect(menu().value).toBe("s2");
    expect(menu().selectedOptions[0]).toHaveTextContent("Selected agent — p (s2) (1)");
    expect(inSidebar("a1")).toBeNull();
  });

  it("a selected row button stays present and focused when its items disappear", () => {
    fakeDaemon();
    usePreferencesStore.setState({ sidebarCollapsed: true } as any);
    setArtifacts([...two(), art("a3", "From agent three", { sessionId: "s3" })]);
    render(<ArtifactPanel />);
    const third = screen.getByRole("button", { name: /^Session 3 \(/ });
    fireEvent.click(third);
    third.focus();
    setArtifacts(two());
    expect(activeRowButton()).toHaveTextContent("Selected agent — s3 (0)");
    expect(activeRowButton()).toHaveFocus();
  });

  it("opening another session's lead works despite an active filter", async () => {
    fakeDaemon();
    setArtifacts([art("a1", "Lead from agent one", { status: "draft" }), art("a2", "From agent two", { status: "draft", sessionId: "s2", createdAt: "2026-06-02T00:00:00.000Z" })]);
    render(<><PendingBanner /><ArtifactPanel /></>);
    fireEvent.change(menu(), { target: { value: "s2" } });
    expect(inSidebar("a1")).toBeNull();
    await userEvent.click(within(screen.getByRole("region", { name: "Waiting for you" })).getByTitle("Lead from agent one"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
    await waitFor(() => expect(document.querySelector('[data-artifact-id="a1"]')).not.toBeNull());
    expect(menu().value).toBe("s1");
    expect(inSidebar("a1")).not.toBeNull();
  });

  it("replay still hides later artifacts while the menu keeps its totals", () => {
    fakeDaemon();
    setArtifacts([art("a1", "Early"), art("a2", "Late", { sessionId: "s2", createdAt: "2026-06-03T00:00:00.000Z" })]);
    useReplayStore.setState({ active: true, cursor: "2026-06-02T00:00:00.000Z" });
    render(<ArtifactPanel />);
    expect(inSidebar("a1")).not.toBeNull();
    expect(inSidebar("a2")).toBeNull();
    expect(Array.from(menu().options).map((o) => o.textContent)).toEqual(["All (2)", "Session 1 (1)", "Session 2 (1)"]);
  });

  it("the n shortcut stays out of the menu", async () => {
    fakeDaemon();
    setArtifacts([art("a1", "One", { status: "draft" }), art("a2", "Two", { sessionId: "s2" })]);
    act(() => useArtifactStore.getState().selectArtifact(null));
    render(<App />);
    fireEvent.keyDown(await screen.findByTestId("agents-filter-menu"), { key: "n" });
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
  });
});

describe("#430 slice 2 D2 — Why on a held terminal ask", () => {
  const Harness = () => (
    <>
      <DiagnosticsMenu onOpenLedger={() => {}} />
      <PendingBanner />
      <input aria-label="composer" />
      <button type="button">elsewhere</button>
    </>
  );
  const why = () => screen.queryByRole("button", { name: "Why this is held" });
  const diagnostics = () => screen.getByRole("button", { name: /diagnostics/i });
  const seedBlocks = (blocks: PreflightBlockRecord[], over: { loaded?: boolean } = {}) =>
    usePreflightBlockStore.setState({ blocks, ...over });
  const entry = (id: string) => document.getElementById(gateEntryDomId(id));
  const entryFocused = (id: string) => waitFor(() => expect(document.activeElement?.id).toBe(gateEntryDomId(id)));
  const copyOfLine = () => screen.getByTestId("pending-next").getAttribute("data-next-copy");
  const draft = () => art("d1", "Next draft", { status: "draft", createdAt: "2026-06-01T05:00:00.000Z" });

  it("appears only for a held terminal lead, outside the chip group, one Tab past the row", async () => {
    fakeDaemon();
    setArtifacts([art("d0", "Draft zero", { status: "draft" }), art("d1", "Draft one", { status: "draft" })]);
    seedBlocks([stance("plain", minute(1)), ask("denied", minute(2), { decision: "deny" })]);
    const { unmount } = render(<Harness />);
    expect(why()).toBeNull();
    unmount();

    setArtifacts([draft(), art("d2", "Another draft", { status: "draft", createdAt: "2026-06-01T05:01:00.000Z" })]);
    seedBlocks([ask("b1", minute(1))]);
    render(<Harness />);
    const button = why()!;
    expect(button).toHaveTextContent(/^Why$/);
    expect(button.closest(".overflow-x-auto")).toBeNull();
    // Not one of the chips, which sit together in their own group.
    expect(button.parentElement?.querySelector(".overflow-x-auto")?.textContent).toContain("Next draft");
    screen.getByRole("group", { name: /answer in the terminal/i }).focus();
    await userEvent.tab();
    expect(button).toHaveFocus();
  });

  it("opens at the entry, marks every held record seen, keeps the instruction, and sends no mutation", async () => {
    const daemon = fakeDaemon();
    setArtifacts([draft()]);
    seedBlocks([ask("newer", minute(5)), ask("older", minute(1))]);
    render(<Harness />);
    expect(copyOfLine()).toContain("HELD IN TERMINAL");
    why()!.focus();
    await userEvent.keyboard("{Enter}");
    await entryFocused("older");

    const state = usePreflightBlockStore.getState();
    expect(state.lastSeenAt).toBe(minute(5)); // log-wide, not just the lead
    expect(unreadBlockCount(state)).toBe(0);
    expect(state.blocks.every((b) => b.seenAt === undefined && b.allowance === undefined)).toBe(true);
    expect(why()).toBeNull();
    expect(copyOfLine()).not.toContain("HELD IN TERMINAL");
    expect(copyOfLine()).toContain("Next draft");
    // Durable history and the terminal instruction are still there.
    expect(entry("newer")).not.toBeNull();
    expect(within(entry("older")!).getByTestId("gate-hook-next")).toHaveTextContent("If Claude Code is still asking, answer in that terminal.");
    expect(daemon.mutations()).toEqual([]);
  });

  it("a hold arriving after the log opened isn't acknowledged until Why is used on it", async () => {
    const daemon = fakeDaemon();
    setArtifacts([draft()]);
    seedBlocks([ask("first", minute(1))]);
    render(<Harness />);
    await userEvent.click(why()!);
    await entryFocused("first");

    act(() => usePreflightBlockStore.getState().pushBlock({
      serverId: "second", at: minute(9), source: "session", concept: "stance second", via: "concept", lane: "hook", decision: "ask", targetPath: "db/n.sql",
    }));
    expect(usePreflightBlockStore.getState().lastSeenAt).toBe(minute(1));
    expect(unreadBlockCount(usePreflightBlockStore.getState())).toBe(1);
    expect(why()).not.toBeNull();
    expect(within(entry("second")!).getByTestId("gate-hook-line")).toHaveTextContent("Claude Code asked to edit");
    expect(within(entry("second")!).getByTestId("gate-hook-next")).toHaveTextContent("If Claude Code is still asking, answer in that terminal.");

    // The log is already open, so no opening moment marks it: this request does.
    why()!.focus();
    await userEvent.keyboard("{Enter}");
    await entryFocused("second");
    expect(usePreflightBlockStore.getState().lastSeenAt).toBe(minute(9));
    expect(why()).toBeNull();
    expect(daemon.mutations()).toEqual([]);
  });

  it.each([
    ["another session", ask("blk_other", minute(1), { sessionId: "s2" }), "blk_other"],
    ["a demo session, no server id", ask("blk:demo/1", minute(1), { sessionId: "demo_1", eligible: false, ineligibleReason: "demo_session" }), "blk:demo/1"],
    ["a server id that differs from the record id", ask("blk_client", minute(1), { serverId: "srv_1" }), "srv_1"],
  ])("resolves an entry from %s", async (_name, block, target) => {
    const daemon = fakeDaemon();
    setArtifacts([art("a1", "One"), art("d1", "Sample", { sessionId: "demo_1" })]);
    seedBlocks([block]);
    render(<Harness />);
    await userEvent.click(why()!);
    await entryFocused(target);
    expect(daemon.mutations()).toEqual([]);
  });

  it.each([
    ["replay", { active: true, exiting: false }],
    ["replay-exit recovery", { active: true, exiting: true }],
    ["the exiting flag alone", { active: false, exiting: true }],
  ])("is withheld during %s, and the held row stays", (_name, replay) => {
    fakeDaemon();
    useReplayStore.setState(replay);
    setArtifacts([draft()]);
    seedBlocks([ask("b1", minute(1))]);
    render(<Harness />);
    expect(why()).toBeNull();
    expect(copyOfLine()).toContain("HELD IN TERMINAL");
    expect(usePreflightBlockStore.getState().focusRequest).toBeNull();
    act(() => useReplayStore.setState({ active: false, exiting: false }));
    expect(why()).not.toBeNull();
  });

  it("reaches an entry past the initial list", async () => {
    fakeDaemon();
    setArtifacts([draft()]);
    seedBlocks([...Array.from({ length: 7 }, (_, i) => stance(`row${i}`, minute(20 - i))), ask("deep", minute(1))]);
    render(<Harness />);
    await userEvent.click(why()!);
    await entryFocused("deep");
    expect(screen.getAllByTestId("gate-block-entry")).toHaveLength(8);
  });

  it("opened before hydration, it waits: no early boundary, then the real entry past the initial list", async () => {
    let land: (rows: PreflightBlockRecord[]) => void = () => {};
    fakeDaemon(() => new Promise((resolve) => { land = resolve; }));
    setArtifacts([draft()]);
    seedBlocks([ask("live", minute(1))], { loaded: false });
    render(<Harness />);
    await userEvent.click(why()!);
    await screen.findByTestId("gate-block-log");
    expect(usePreflightBlockStore.getState().lastSeenAt).toBeNull();
    expect(why()).not.toBeNull();

    await act(async () => { land(Array.from({ length: 7 }, (_, i) => stance(`row${i}`, minute(30 - i)))); });
    await entryFocused("live");
    expect(usePreflightBlockStore.getState().lastSeenAt).toBe(minute(30));
    expect(why()).toBeNull();
  });

  it("closing before hydration cancels the request: it can't reopen later", async () => {
    let land: (rows: PreflightBlockRecord[]) => void = () => {};
    fakeDaemon(() => new Promise((resolve) => { land = resolve; }));
    setArtifacts([draft()]);
    seedBlocks([ask("live", minute(1))], { loaded: false });
    render(<Harness />);
    const button = why()!;
    await userEvent.click(button);
    await screen.findByTestId("gate-block-log");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
    expect(button).toHaveFocus(); // still mounted, still a real control
    await act(async () => { land([]); });
    expect(usePreflightBlockStore.getState().focusRequest).toBeNull();
    expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
    expect(usePreflightBlockStore.getState().lastSeenAt).toBeNull();
    expect(why()).toBe(button);
  });

  it("a missing target says so in the log and holds focus there; Esc then returns to ⋯", async () => {
    const daemon = fakeDaemon();
    seedBlocks([stance("present", minute(1))]);
    render(<Harness />);
    act(() => openGateLogEntry("gone"));
    const log = await screen.findByTestId("gate-block-log");
    await waitFor(() => expect(log).toHaveFocus());
    expect(screen.getByTestId("gate-entry-missing")).toHaveTextContent(/isn't in this log any more/);
    expect(entry("present")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(diagnostics()).toHaveFocus();
    expect(daemon.mutations()).toEqual([]);
  });

  it("an empty log with a missing target doesn't claim no blocks ever fired", async () => {
    fakeDaemon();
    render(<Harness />);
    act(() => openGateLogEntry("gone"));
    await screen.findByTestId("gate-entry-missing");
    expect(screen.queryByText(/No blocks yet/)).not.toBeInTheDocument();
  });

  it("a target pruned by hydration falls back the same way", async () => {
    fakeDaemon(() => Array.from({ length: 25 }, (_, i) => stance(`row${i}`, minute(30 + i))));
    setArtifacts([draft()]);
    seedBlocks([ask("oldest", minute(1))], { loaded: false });
    render(<Harness />);
    await userEvent.click(why()!);
    await screen.findByTestId("gate-entry-missing");
    expect(screen.getByTestId("gate-block-log")).toHaveFocus();
    expect(entry("oldest")).toBeNull();
    expect(why()).toBeNull();
  });

  describe("Why unmounting without being pressed", () => {
    // Blocking, like the ask, and older, so it takes the lead (oldest first in the tier).
    const olderDecision = () => art("old", "Older sibling decision", {
      type: "decision", status: "draft", sessionId: "s2", createdAt: "2026-06-01T00:30:00.000Z",
      content: { context: "c", options: [], decisionId: "dec_old" },
    });
    const focusedWhy = (blocks: PreflightBlockRecord[], artifacts: unknown[]) => {
      fakeDaemon();
      setArtifacts(artifacts);
      seedBlocks(blocks);
      render(<Harness />);
      const button = why()!;
      button.focus();
      expect(button).toHaveFocus();
      return button;
    };

    it("an older draft taking the lead moves focus to the banner's first stop", () => {
      const button = focusedWhy([ask("b1", minute(1))], [draft()]);
      setArtifacts([draft(), olderDecision()]);
      expect(button.isConnected).toBe(false);
      expect(document.activeElement).toBe(within(screen.getByRole("region", { name: "Waiting for you" })).getByTitle("Older sibling decision"));
    });

    it("a grant writing seenAt with no drafts left moves focus to ⋯", () => {
      const button = focusedWhy([ask("b1", minute(1), { serverId: "b1" })], [art("a1", "Done")]);
      act(() => usePreflightBlockStore.getState().applyReceipt("b1", { id: "sx_1", state: "allowed" } as any, minute(2)));
      expect(button.isConnected).toBe(false);
      expect(screen.queryByRole("region", { name: "Waiting for you" })).not.toBeInTheDocument();
      expect(diagnostics()).toHaveFocus();
    });

    it("the cap pruning the ask moves focus to the banner's first stop", () => {
      const button = focusedWhy([ask("b1", minute(1))], [draft()]);
      act(() => usePreflightBlockStore.setState({ blocks: Array.from({ length: 25 }, (_, i) => stance(`row${i}`, minute(30 + i))) }));
      expect(button.isConnected).toBe(false);
      expect(document.activeElement).toBe(within(screen.getByRole("region", { name: "Waiting for you" })).getByTitle("Next draft"));
    });

    it("focus elsewhere is left alone", () => {
      const button = focusedWhy([ask("b1", minute(1))], [draft()]);
      const composer = screen.getByRole("textbox", { name: "composer" });
      composer.focus();
      setArtifacts([draft(), olderDecision()]);
      expect(button.isConnected).toBe(false);
      expect(composer).toHaveFocus();
    });
  });

  describe("focus return", () => {
    const openedAtEntry = async () => {
      fakeDaemon();
      setArtifacts([draft()]);
      seedBlocks([ask("b1", minute(1))]);
      const view = render(<Harness />);
      const button = why()!;
      await userEvent.click(button);
      await entryFocused("b1");
      expect(button.isConnected).toBe(false);
      return view;
    };

    it("Escape goes to ⋯, not a detached Why or body", async () => {
      await openedAtEntry();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
      expect(diagnostics()).toHaveFocus();
    });

    it("closing with the gate chip stays on the chip", async () => {
      await openedAtEntry();
      const chip = screen.getByRole("button", { name: /show recent gate blocks/i });
      await userEvent.click(chip);
      expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
      expect(chip).toHaveFocus();
    });

    it("closing with ⋯ stays on ⋯", async () => {
      await openedAtEntry();
      await userEvent.click(diagnostics());
      expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
      expect(diagnostics()).toHaveFocus();
    });

    it("a click outside keeps the clicked control", async () => {
      await openedAtEntry();
      const elsewhere = screen.getByRole("button", { name: "elsewhere" });
      await userEvent.click(elsewhere);
      expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
      expect(elsewhere).toHaveFocus();
    });

    it("Escape with focus elsewhere closes the log and leaves focus alone", async () => {
      await openedAtEntry();
      const composer = screen.getByRole("textbox", { name: "composer" });
      composer.focus();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
      expect(composer).toHaveFocus();
    });
  });
});
