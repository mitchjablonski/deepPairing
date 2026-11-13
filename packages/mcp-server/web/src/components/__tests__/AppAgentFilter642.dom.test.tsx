import { sessionVisits } from "../../lib/session-visits";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import App from "../../App";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";
import { usePreferencesStore } from "../../stores/preferences";
import { useSiblingSyncStore } from "../../lib/siblingSync";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";

const art = (id: string, sessionId = "A", over: Partial<Artifact> = {}): Artifact => ({
  id, sessionId, title: "Duplicate title", type: "research", status: "draft", version: 1, parentId: null,
  content: { summary: id, findings: [] }, agentReasoning: null,
  createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", ...over,
} as Artifact);
const menu = () => screen.getByTestId("agents-filter-menu") as HTMLSelectElement;
const choose = (owner: string) => fireEvent.change(menu(), { target: { value: owner } });
const selected = () => useArtifactStore.getState().selectedArtifactId;
const pane = (id: string) => document.querySelector('[data-artifact-id="' + id + '"]');
const seed = (artifacts = [art("a1"), art("a2"), art("b1", "B")]) => {
  useArtifactStore.setState({ artifacts, selectedArtifactId: "b1" });
};

beforeEach(() => {
  useConnectionStore.getState().disconnect();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sessions: [], blocks: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } })));
  const browserNavigator = Object.create(navigator);
  Object.defineProperty(browserNavigator, "locks", { value: { request: (_name: string, work: () => void) => Promise.resolve(work()) } });
  vi.stubGlobal("navigator", browserNavigator);
  sessionVisits.resetRuntime();
  sessionVisits.beginBinding();
  const visit = sessionVisits.plan({ projectRoot: "/project", sessionId: "bound", currentSelection: null });
  sessionVisits.commit(visit, [], null);
  useArtifactStore.getState().reset();
  useArtifactStore.setState({ agentFilter: "all", filterBinding: null, navigationEpoch: 0, exactNavigationId: null });
  useReplayStore.setState({ active: false, exiting: false, cursor: "" });
  usePreferencesStore.setState({ sidebarCollapsed: false, nextUpBar: false });
  useSiblingSyncStore.setState({ settled: true });
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null, loaded: true });
  useConnectionStore.setState({ adapter: { connect() {}, disconnect() {}, onMessage() {}, onConnect() {}, onDisconnect() {}, switchSession() {} }, connected: true, hydrated: true, hydratedBinding: "bound@/project", sessionId: "bound",
    projectRoot: "/project", activeSessions: [{ sessionId: "bound", live: true, artifactCount: 3 }] } as any);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("#642 mounted App filter-following navigation", () => {
  it("chooses the first canonical pending by owner identity and partitions global pending counts", async () => {
    seed([art("a-find"), art("b1", "B"), art("a-decision", "A", { type: "decision", content: { context: "choose", options: [] } as any })]);
    render(<App />);
    choose("A");
    expect(selected()).toBe("a-decision");
    expect(menu().value).toBe("A");
    expect(screen.getByTestId("agent-filter-scope")).toHaveTextContent("2 pending here · 1 in other agents");
    expect(screen.getByTestId("pending-banner")).toHaveTextContent("3 items waiting for you");
    await waitFor(() => expect(pane("a-decision")).not.toBeNull());
    expect(pane("b1")).toBeNull();
  });

  it("n/N use the fresh scoped queue after arrivals, resolution, removal and nonpending selection", () => {
    seed(); render(<App />); choose("A");
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a2");
    act(() => useArtifactStore.getState().addArtifact(art("a0", "A", { type: "decision", content: { context: "choose", options: [] } as any })));
    expect(selected()).toBe("a2");
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a0");
    act(() => useArtifactStore.getState().updateArtifact("a0", "approved"));
    fireEvent.keyDown(document, { key: "N" }); expect(selected()).toBe("a2");
    act(() => useArtifactStore.setState({ artifacts: useArtifactStore.getState().artifacts.filter((a) => a.id !== "a2") }));
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a1");
    act(() => useArtifactStore.getState().updateArtifact("a1", "approved"));
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a1");
    expect(menu().value).toBe("A");
  });

  it("j/k retain visible insertion order and clamp, with native select and modifier suppression", () => {
    seed(); render(<App />); choose("A");
    fireEvent.keyDown(menu(), { key: "n" }); expect(selected()).toBe("a1");
    fireEvent.keyDown(document, { key: "j", ctrlKey: true }); expect(selected()).toBe("a1");
    fireEvent.keyDown(document, { key: "j" }); expect(selected()).toBe("a2");
    fireEvent.keyDown(document, { key: "j" }); expect(selected()).toBe("a2");
    fireEvent.keyDown(document, { key: "k" }); expect(selected()).toBe("a1");
  });

  it.each(["collapsed", "narrow"])("scoped navigation remains live in the %s App layout", (layout) => {
    if (layout === "collapsed") usePreferencesStore.setState({ sidebarCollapsed: true });
    if (layout === "narrow") vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(max-width: 900px)", media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    }));
    seed(); render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Agent 1 \(/ }));
    expect(selected()).toBe("a1");
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a2");
    fireEvent.keyDown(document, { key: "j" }); expect(selected()).toBe("a2");
    fireEvent.keyDown(document, { key: "N" }); expect(selected()).toBe("a1");
  });

  it("Show all keeps a valid receipt rather than jumping to another agent's pending head", () => {
    seed([art("receipt", "A", { status: "approved" }), art("b1", "B")]);
    render(<App />); choose("A"); choose("all");
    expect(selected()).toBe("receipt");
  });

  it("keeps a valid scoped receipt when no pending remains, otherwise chooses the first visible fallback", () => {
    seed([art("receipt", "A", { status: "approved" }), art("b1", "B")]);
    render(<App />); choose("A"); expect(selected()).toBe("receipt");
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("receipt");
    choose("A"); expect(selected()).toBe("receipt");
    expect(screen.getByTestId("agent-filter-scope")).toHaveTextContent("0 pending here · 1 in other agents");
  });

  it("retains unavailable choice across a same-session snapshot reset without showing another owner's detail", async () => {
    seed(); render(<App />); choose("A");
    act(() => { useArtifactStore.getState().reset(); useArtifactStore.setState({ artifacts: [art("b1", "B")], selectedArtifactId: "b1" }); });
    expect(menu().value).toBe("A");
    expect(screen.getByTestId("agent-filter-empty")).toBeInTheDocument();
    expect(pane("b1")).toBeNull();
    const recover = screen.getByRole("button", { name: "Show all agents" }); recover.focus();
    fireEvent.click(recover);
    expect(screen.queryByTestId("agents-filter-menu")).toBeNull();
    expect(useArtifactStore.getState().agentFilter).toBe("all"); expect(selected()).toBe("b1");
    await waitFor(() => expect(pane("b1")).not.toBeNull());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("resets only for an actual bound-session/project switch and retains root enrichment/catalog loss", () => {
    seed(); render(<App />); choose("A");
    act(() => useConnectionStore.setState({ projectRoot: null }));
    act(() => useConnectionStore.setState({ projectRoot: "/project", activeSessions: [] }));
    expect(menu().value).toBe("A");
    act(() => useConnectionStore.setState({ connected: false, hydrated: false }));
    act(() => useConnectionStore.setState({ connected: true, hydrated: true }));
    expect(menu().value).toBe("A");
    act(() => useConnectionStore.setState({ projectRoot: "/another" }));
    expect(useArtifactStore.getState().agentFilter).toBe("all");
    expect(screen.queryByRole("combobox", { name: /^Agents/ })).toBeNull();
    act(() => useConnectionStore.setState({ hydratedBinding: "bound@/another" }));
    expect(menu().value).toBe("all");
    choose("A");
    act(() => useConnectionStore.setState({ sessionId: "different" }));
    expect(useArtifactStore.getState().agentFilter).toBe("all");
    expect(screen.queryByRole("combobox", { name: /^Agents/ })).toBeNull();
    act(() => useConnectionStore.setState({ hydratedBinding: "different@/another" }));
    expect(menu().value).toBe("all");
  });

  it("explicit global high token opens follow owner atomically, same-agent stays scoped, All stays All", () => {
    const extra = Array.from({ length: 5 }, (_, i) => art("p" + i, "A", { createdAt: "2026-05-01T00:00:00.000Z", type: "spec", content: { objective: "Review", requirements: [], context: "Review: packet" } as any }));
    seed([...extra, art("b-high", "B", { type: "decision", content: { context: "choose", stakes: "high", options: [] } as any })]);
    render(<App />); choose("A");
    const publications: { owner: string; id: string | null }[] = [];
    const stop = useArtifactStore.subscribe((s) => publications.push({ owner: s.agentFilter, id: s.selectedArtifactId }));
    fireEvent.click(screen.getByRole("button", { name: /1 high-stakes decision waiting/ })); stop();
    expect(publications).toEqual([{ owner: "B", id: "b-high" }]);
    expect(menu().value).toBe("B"); expect(selected()).toBe("b-high");
    expect(useConnectionStore.getState().sessionId).toBe("bound");
    act(() => window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "b-high" } })));
    expect(menu().value).toBe("B");
    choose("all");
    act(() => window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "b-high" } })));
    expect(menu().value).toBe("all"); expect(selected()).toBe("b-high");
  });

  it("replay navigation respects cutoff and scoped n/N, rejecting a future explicit open", () => {
    seed([art("a1"), art("a-future", "A", { createdAt: "2026-07-01T00:00:00.000Z" }), art("b1", "B")]);
    useReplayStore.setState({ active: true, cursor: "2026-06-02T00:00:00.000Z" });
    render(<App />); choose("A");
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a1");
    fireEvent.keyDown(document, { key: "j" }); expect(selected()).toBe("a1");
    act(() => window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "a-future" } })));
    expect(selected()).toBe("a1"); expect(menu().value).toBe("A");
    act(() => useReplayStore.setState({ active: false, cursor: "" }));
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a-future");
  });

  it("fulfills the same unloaded Open intent using its real owner without receipt leakage", () => {
    seed();
    useConnectionStore.setState({ sessionId: "A", hydratedBinding: "A@/project" });
    const accepted = sessionVisits.plan({ projectRoot: "/project", sessionId: "A", currentSelection: "a1" });
    sessionVisits.commit(accepted, useArtifactStore.getState().artifacts, "a1");
    sessionVisits.select("a1", "A");
    render(<App />); choose("A");
    localStorage.setItem("dp-selected-artifact", "a1");
    const visits = localStorage.getItem("dp-session-visits-v1");
    expect(JSON.parse(visits!).entries[JSON.stringify(["/project", "A"])].selected).toBe("a1");
    expect(localStorage.getItem("dp-selected-artifact")).toBe("a1");
    act(() => window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "missing" } })));
    expect(selected()).toBe("missing"); expect(menu().value).toBe("A");
    expect(screen.getByText(/This artifact is unavailable/)).toBeInTheDocument();
    expect(localStorage.getItem("dp-selected-artifact")).toBe("a1");
    act(() => useArtifactStore.getState().addArtifact(art("missing", "B")));
    expect(selected()).toBe("missing"); expect(menu().value).toBe("B");
    expect(localStorage.getItem("dp-selected-artifact")).toBe("a1");
    expect(localStorage.getItem("dp-session-visits-v1")).toBe(visits);
  });

  it.each(["selection", "filter", "session", "replay"])("late unknown target does not supersede newer %s intent", (intent) => {
    seed(); render(<App />); choose("A");
    act(() => window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "late" } })));
    if (intent === "selection") act(() => useArtifactStore.getState().openArtifact("a2"));
    if (intent === "filter") choose("B");
    if (intent === "session") act(() => useConnectionStore.setState({ sessionId: "other" }));
    if (intent === "replay") act(() => useReplayStore.setState({ active: true, cursor: "2026-06-02T00:00:00.000Z" }));
    const id = selected(); const filter = useArtifactStore.getState().agentFilter;
    act(() => useArtifactStore.getState().addArtifact(art("late", "B")));
    expect(selected()).toBe(id); expect(useArtifactStore.getState().agentFilter).toBe(filter);
  });

  it("does not fulfill an unknown replay target created after the cursor", () => {
    seed(); useReplayStore.setState({ active: true, cursor: "2026-06-02T00:00:00.000Z" });
    render(<App />); choose("A");
    act(() => useArtifactStore.getState().openArtifact("future"));
    act(() => useArtifactStore.getState().addArtifact(art("future", "B", { createdAt: "2026-07-01T00:00:00.000Z" })));
    expect(menu().value).toBe("A"); expect(pane("future")).toBeNull();
  });

  it("preserves scoped explicit superseded-version detail and clears exact intent on filter navigation", async () => {
    seed([art("a-old", "A", { status: "superseded" }), art("a-current", "A", { parentId: "a-old" }), art("b1", "B")]);
    render(<App />); choose("B");
    act(() => useArtifactStore.getState().openArtifactExact("a-old"));
    expect(menu().value).toBe("A"); expect(selected()).toBe("a-old");
    await waitFor(() => expect(pane("a-old")).not.toBeNull());
    choose("A"); expect(selected()).toBe("a-current"); expect(useArtifactStore.getState().exactNavigationId).toBeNull();
  });

  it.each([false, true])("successful real changeset POST advances only within the latest scoped queue (arrival=%s)", async (arrival) => {
    let finish!: () => void;
    const response = () => new Response(JSON.stringify({ blocks: [], sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && String(input).includes("/a-cs/status")) {
        return new Promise<Response>((resolve) => { finish = () => resolve(response()); });
      }
      return response();
    }));
    useConnectionStore.setState({ sessionId: "A", hydratedBinding: "A@/project" });
    const cs = art("a-cs", "A", { type: "changeset", content: { summary: "change", files: [{ path: "a.ts", changeType: "modified", hunks: [] }], reviewState: { "a.ts": "needs_changes" }, reviewReasons: { "a.ts": "fix" } } as any });
    seed([cs, art("b-high", "B", { type: "decision", content: { context: "choose", stakes: "high", options: [] } as any })]);
    render(<App />); choose("A");
    fireEvent.click(await screen.findByTestId("send-back"));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (arrival) act(() => useArtifactStore.getState().addArtifact(art("a-arrival")));
    await act(async () => { finish(); });
    expect(selected()).toBe(arrival ? "a-arrival" : "a-cs");
    expect(menu().value).toBe("A");
    expect(useArtifactStore.getState().artifacts.find((a) => a.id === "a-cs")?.status).toBe("revised");
  });

  it.each(["filter", "selection", "binding", "replay"])("a delayed changeset verdict cannot hijack newer %s intent", async (intent) => {
    let finish!: () => void;
    const update = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const original = useArtifactStore.getState().updateArtifactStatus;
    const cs = art("a-cs", "A", { type: "changeset", content: { summary: "change", files: [{ path: "a.ts", changeType: "modified", hunks: [] }], reviewState: { "a.ts": "needs_changes" }, reviewReasons: { "a.ts": "fix" } } as any });
    seed([cs, art("a2"), art("b1", "B"), art("b2", "B")]);
    useArtifactStore.setState({ updateArtifactStatus: update });
    try {
      render(<App />); choose("A");
      fireEvent.click(await screen.findByTestId("send-back"));
      await waitFor(() => expect(update).toHaveBeenCalled());
      if (intent === "filter") choose("B");
      if (intent === "selection") act(() => window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "a2" } })));
      if (intent === "binding") act(() => useConnectionStore.setState({ sessionId: "different" }));
      if (intent === "replay") act(() => useReplayStore.setState({ active: true, cursor: "2026-06-02T00:00:00.000Z" }));
      const before = selected();
      await act(async () => { finish(); });
      expect(selected()).toBe(before);
    } finally { useArtifactStore.setState({ updateArtifactStatus: original }); }
  });
});
